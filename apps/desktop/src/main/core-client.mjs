import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';

const PROTOCOL = 'superwagie-product-v1';
const CORE_IDENTITY = 'superwagie-rust-product-core';
const MAX_MESSAGE_BYTES = 1024 * 1024;

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
  return timingSafeEqual(Buffer.from(macHex(key, value), 'hex'), Buffer.from(supplied, 'hex'));
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export class CoreClient {
  constructor({ binary, stateRoot, onDisconnected = () => {}, handshakeTimeoutMs = 5_000, spawnProcess = spawn }) {
    this.binary = binary;
    this.stateRoot = stateRoot;
    this.onDisconnected = onDisconnected;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.child = null;
    this.sequence = 0;
    this.intentionalStop = false;
  }

  async start() {
    if (this.child) throw new Error('CORE_ALREADY_STARTED');
    this.key = randomBytes(32);
    this.mainNonce = randomBytes(24).toString('hex');
    const child = this.spawnProcess(this.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        SUPERWAGIE_CORE_KEY: this.key.toString('hex'),
        SUPERWAGIE_STATE_ROOT: this.stateRoot,
      },
    });
    this.child = child;
    this.stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
        this.rejectAll(new Error('CORE_RESPONSE_TOO_LARGE'));
        child.kill('SIGKILL');
        return;
      }
      try {
        const response = JSON.parse(line);
        const waiter = this.pending.get(response?.request_id);
        if (waiter) this.settle(response.request_id, 'resolve', response);
      } catch (error) {
        this.rejectAll(error);
      }
    });
    child.on('error', (error) => this.rejectAll(error));
    child.on('exit', (code, signal) => {
      this.rejectAll(new Error(`CORE_EXITED:${code}:${signal}:${this.stderr}`));
      if (!this.intentionalStop) this.onDisconnected({ code, signal, pid: child.pid });
    });

    try {
      const requestId = `hello-${randomBytes(8).toString('hex')}`;
      const deadlineMs = Date.now() + this.handshakeTimeoutMs;
      const hello = await this.sendRaw({
        type: 'hello',
        protocol: PROTOCOL,
        request_id: requestId,
        deadline_ms: deadlineMs,
        main_nonce: this.mainNonce,
        main_identity: 'electron-main@44.1.0',
      }, this.handshakeTimeoutMs);
      const keys = ['type', 'protocol', 'request_id', 'deadline_ms', 'main_nonce', 'core_nonce', 'identity', 'pid', 'mac'];
      if (!exactKeys(hello, keys)
        || hello.type !== 'hello_ack'
        || hello.protocol !== PROTOCOL
        || hello.request_id !== requestId
        || hello.deadline_ms !== deadlineMs
        || hello.main_nonce !== this.mainNonce
        || hello.identity !== CORE_IDENTITY
        || hello.pid !== child.pid
        || typeof hello.core_nonce !== 'string') {
        throw new Error('CORE_HANDSHAKE_IDENTITY_REJECTED');
      }
      const { mac, ...unsigned } = hello;
      if (!verifyMac(this.key, unsigned, mac)) throw new Error('CORE_HANDSHAKE_MAC_REJECTED');
      this.coreNonce = hello.core_nonce;
      return Object.freeze({ ...hello });
    } catch (error) {
      await this.forceStop();
      throw error;
    }
  }

  settle(requestId, action, value) {
    const waiter = this.pending.get(requestId);
    if (!waiter) return;
    this.pending.delete(requestId);
    clearTimeout(waiter.timer);
    waiter[action](value);
  }

  rejectAll(error) {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, 'reject', error);
  }

  sendRaw(message, timeoutMs = 5_000) {
    if (!this.child?.stdin?.writable) throw new Error('CORE_DISCONNECTED');
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) throw new Error('CORE_REQUEST_TOO_LARGE');
    if (typeof message.request_id !== 'string' || !message.request_id || this.pending.has(message.request_id)) {
      throw new Error('CORE_REQUEST_ID_INVALID');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(message.request_id, 'reject', new Error('CORE_REQUEST_TIMEOUT')), timeoutMs);
      this.pending.set(message.request_id, { resolve, reject, timer });
      this.child.stdin.write(encoded, (error) => {
        if (error) this.settle(message.request_id, 'reject', error);
      });
    });
  }

  async request(command, { timeoutMs = 5_000 } = {}) {
    if (!this.coreNonce) throw new Error('CORE_HANDSHAKE_INCOMPLETE');
    const sequence = this.sequence + 1;
    const requestId = `request-${sequence}-${randomBytes(8).toString('hex')}`;
    const deadlineMs = Date.now() + timeoutMs;
    const unsigned = {
      type: 'request', protocol: PROTOCOL, request_id: requestId, deadline_ms: deadlineMs,
      main_nonce: this.mainNonce, core_nonce: this.coreNonce, sequence, command,
    };
    const signed = { ...unsigned, mac: macHex(this.key, unsigned) };
    if (Buffer.byteLength(JSON.stringify(signed)) + 1 > MAX_MESSAGE_BYTES) {
      throw new Error('CORE_REQUEST_TOO_LARGE');
    }
    this.sequence = sequence;
    const response = await this.sendRaw(signed, timeoutMs);
    const common = ['type', 'protocol', 'request_id', 'deadline_ms', 'main_nonce', 'core_nonce', 'sequence', 'identity', 'ok', 'mac'];
    const expected = response?.ok === true ? [...common, 'result'] : [...common, 'code'];
    if (!exactKeys(response, expected)
      || response.type !== 'response'
      || response.protocol !== PROTOCOL
      || response.request_id !== requestId
      || response.deadline_ms !== deadlineMs
      || response.main_nonce !== this.mainNonce
      || response.core_nonce !== this.coreNonce
      || response.sequence !== sequence
      || response.identity !== CORE_IDENTITY) {
      throw new Error('CORE_RESPONSE_IDENTITY_REJECTED');
    }
    const { mac, ...unsignedResponse } = response;
    if (!verifyMac(this.key, unsignedResponse, mac)) throw new Error('CORE_RESPONSE_MAC_REJECTED');
    if (!response.ok) throw new Error(response.code);
    return response.result;
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
    await Promise.race([this.waitForExit(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }

  async shutdown({ timeoutMs = 5_000 } = {}) {
    if (!this.child) return;
    this.intentionalStop = true;
    try {
      if (this.child.stdin.writable && this.coreNonce) await this.request({ type: 'shutdown' }, { timeoutMs });
      this.child.stdin.end();
      await Promise.race([
        this.waitForExit(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('CORE_SHUTDOWN_TIMEOUT')), timeoutMs)),
      ]);
    } catch (error) {
      await this.forceStop();
      throw error;
    }
  }
}
