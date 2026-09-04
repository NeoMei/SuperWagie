import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const PROTOCOL = 'solution-b-v1';
const CORE_IDENTITY = 'solution-b-rust-core';
const MAX_MESSAGE_BYTES = 64 * 1024;

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function macHex(key, value) {
  return createHmac('sha256', key).update(canonicalJson(value)).digest('hex');
}

function verifyMac(key, value, supplied) {
  if (!/^[a-f0-9]{64}$/.test(supplied ?? '')) return false;
  const expected = Buffer.from(macHex(key, value), 'hex');
  const actual = Buffer.from(supplied, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export function createCheckpointKeyCustody() {
  const directory = mkdtempSync(join(tmpdir(), 'superwagie-checkpoint-key-'));
  const path = join(directory, 'custody');
  const fd = openSync(path, 'wx+', 0o600);
  try {
    const key = randomBytes(32);
    if (writeSync(fd, key, 0, key.length, 0) !== key.length) throw new Error('checkpoint key custody write failed');
    fsyncSync(fd);
    unlinkSync(path);
    rmdirSync(directory);
  } catch (error) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(path); } catch {}
    try { rmdirSync(directory); } catch {}
    throw error;
  }
  let closed = false;
  return Object.freeze({
    fd,
    kind: 'unlinked-fd',
    close() { if (!closed) { closed = true; closeSync(fd); } },
  });
}

export class CoreClient {
  constructor({
    binary,
    checkpointPath,
    checkpointKeyFd,
    onDisconnected = () => {},
    handshakeTimeoutMs = 5_000,
    spawnProcess = spawn,
  }) {
    this.binary = binary;
    this.checkpointPath = checkpointPath;
    this.checkpointKeyFd = checkpointKeyFd;
    this.onDisconnected = onDisconnected;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.child = null;
    this.key = null;
    this.mainNonce = null;
    this.coreNonce = null;
    this.sequence = 0;
    this.rawStdoutLines = [];
    this.rawRequestLines = [];
    this.intentionalStop = false;
  }

  async start() {
    if (this.child) throw new Error('core client already started');
    this.key = randomBytes(32).toString('hex');
    this.mainNonce = randomBytes(16).toString('hex');
    const child = this.spawnProcess(this.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe', this.checkpointKeyFd],
      env: {
        SUPERWAGIE_CORE_KEY: this.key,
        SUPERWAGIE_CHECKPOINT_PATH: this.checkpointPath,
        SUPERWAGIE_CHECKPOINT_KEY_FD: '3',
      },
    });
    this.child = child;
    this.stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      this.rawStdoutLines.push(line);
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
        this.rejectAll(new Error('CORE_RESPONSE_TOO_LARGE'));
        return;
      }
      try {
        const response = JSON.parse(line);
        const waiter = this.pending.get(response?.request_id);
        if (!waiter) return;
        this.settle(response.request_id, 'resolve', response);
      } catch (error) {
        this.rejectAll(error);
      }
    });
    child.on('error', (error) => {
      this.rejectAll(error);
    });
    child.on('exit', (code, signal) => {
      this.rejectAll(new Error(`core exited code=${code} signal=${signal}: ${this.stderr}`));
      if (!this.intentionalStop) this.onDisconnected({ code, signal, pid: child.pid });
    });

    try {
      const requestId = `hello-${randomBytes(8).toString('hex')}`;
      const deadlineMs = Date.now() + this.handshakeTimeoutMs;
      const hello = await this.sendRaw({
        type: 'hello', protocol: PROTOCOL, request_id: requestId, deadline_ms: deadlineMs,
        main_nonce: this.mainNonce, main_identity: 'electron-main@44.1.0',
      }, { timeoutMs: this.handshakeTimeoutMs, timeoutCode: 'CORE_HANDSHAKE_TIMEOUT' });
      const helloKeys = ['type', 'protocol', 'request_id', 'deadline_ms', 'main_nonce', 'core_nonce', 'identity', 'pid', 'mac'];
      if (!exactKeys(hello, helloKeys) || hello.type !== 'hello_ack' || hello.protocol !== PROTOCOL
        || hello.request_id !== requestId || hello.deadline_ms !== deadlineMs
        || hello.main_nonce !== this.mainNonce || hello.identity !== CORE_IDENTITY
        || typeof hello.core_nonce !== 'string' || hello.core_nonce.length < 8
        || !Number.isSafeInteger(hello.pid) || hello.pid !== child.pid) {
        throw new Error(`core handshake identity rejected: ${JSON.stringify(hello)}`);
      }
      const { mac, ...unsigned } = hello;
      if (!verifyMac(this.key, unsigned, mac)) throw new Error('core handshake MAC rejected');
      this.coreNonce = hello.core_nonce;
      this.identity = Object.freeze({ ...hello });
      return this.identity;
    } catch (error) {
      await this.forceStop();
      throw error;
    }
  }

  settle(requestId, action, value) {
    const waiter = this.pending.get(requestId);
    if (!waiter) return false;
    this.pending.delete(requestId);
    clearTimeout(waiter.timer);
    waiter[action](value);
    return true;
  }

  rejectAll(error) {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, 'reject', error);
  }

  sendRaw(message, { timeoutMs = 5_000, timeoutCode = 'CORE_REQUEST_TIMEOUT' } = {}) {
    if (!this.child?.stdin?.writable) throw new Error('core channel is disconnected');
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) throw new Error('CORE_REQUEST_TOO_LARGE');
    if (typeof message.request_id !== 'string' || !message.request_id || this.pending.has(message.request_id)) {
      throw new Error('CORE_REQUEST_ID_INVALID');
    }
    return new Promise((resolve, reject) => {
      this.rawRequestLines.push(encoded.trimEnd());
      const timer = setTimeout(() => {
        this.settle(message.request_id, 'reject', new Error(timeoutCode));
      }, timeoutMs);
      this.pending.set(message.request_id, { resolve, reject, timer });
      this.child.stdin.write(encoded, (error) => {
        if (!error) return;
        this.settle(message.request_id, 'reject', error);
      });
    });
  }

  async request(command, { timeoutMs = 5_000 } = {}) {
    if (!this.coreNonce) throw new Error('core handshake incomplete');
    const sequence = ++this.sequence;
    const requestId = `request-${sequence}-${randomBytes(8).toString('hex')}`;
    const deadlineMs = Date.now() + timeoutMs;
    const unsigned = {
      type: 'request', protocol: PROTOCOL, request_id: requestId, deadline_ms: deadlineMs,
      main_nonce: this.mainNonce, core_nonce: this.coreNonce, sequence, command,
    };
    const response = await this.sendRaw(
      { ...unsigned, mac: macHex(this.key, unsigned) },
      { timeoutMs, timeoutCode: 'CORE_REQUEST_TIMEOUT' },
    );
    const common = ['type', 'protocol', 'request_id', 'deadline_ms', 'main_nonce', 'core_nonce', 'sequence', 'identity', 'ok', 'mac'];
    const expectedKeys = response?.ok === true ? [...common, 'result'] : [...common, 'code'];
    if (!exactKeys(response, expectedKeys) || response.type !== 'response' || response.protocol !== PROTOCOL
      || response.request_id !== requestId || response.deadline_ms !== deadlineMs
      || response.main_nonce !== this.mainNonce || response.core_nonce !== this.coreNonce
      || response.sequence !== sequence || response.identity !== CORE_IDENTITY
      || typeof response.ok !== 'boolean') {
      throw new Error(`core response identity rejected: ${JSON.stringify(response)}`);
    }
    const { mac, ...unsignedResponse } = response;
    if (!verifyMac(this.key, unsignedResponse, mac)) throw new Error('core response MAC rejected');
    return response.ok ? response.result : { code: response.code };
  }

  waitForExit() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => this.child.once('exit', resolve));
  }

  async forceStop() {
    const child = this.child;
    if (!child) return;
    this.intentionalStop = true;
    this.rejectAll(new Error('CORE_STOPPED'));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    let timer;
    try {
      await Promise.race([
        this.waitForExit(),
        new Promise((resolve) => { timer = setTimeout(resolve, 1_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown({ timeoutMs = 5_000 } = {}) {
    if (!this.child) return;
    this.intentionalStop = true;
    try {
      if (!this.child.stdin.writable || !this.coreNonce) throw new Error('core channel is disconnected');
      await this.request({ type: 'shutdown' }, { timeoutMs });
      this.child.stdin.end();
      let timer;
      try {
        await Promise.race([
          this.waitForExit(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CORE_SHUTDOWN_TIMEOUT')), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      await this.forceStop();
      throw error;
    }
  }
}
