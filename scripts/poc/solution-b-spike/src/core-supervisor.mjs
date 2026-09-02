import { CoreClient, createCheckpointKeyCustody } from './core-client.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CoreSupervisor {
  constructor({ binary, checkpointPath, heartbeatIntervalMs = 250, heartbeatTimeoutMs = 1_000, onState = () => {} }) {
    this.binary = binary;
    this.checkpointPath = checkpointPath;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.onState = onState;
    this.state = 'created';
    this.history = [];
    this.restartCount = 0;
    this.crashCount = 0;
    this.stopping = false;
    this.waiters = [];
    this.heartbeatBusy = false;
    this.clients = [];
    this.checkpointKeyCustody = createCheckpointKeyCustody();
  }

  transition(state, details = {}) {
    this.state = state;
    const event = { state, at_ms: Date.now(), ...details };
    this.history.push(event);
    this.onState(event);
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async startClient({ recovery = false } = {}) {
    const client = new CoreClient({
      binary: this.binary,
      checkpointPath: this.checkpointPath,
      checkpointKeyFd: this.checkpointKeyCustody.fd,
      onDisconnected: (event) => this.handleDisconnect(client, event),
    });
    this.client = client;
    this.clients.push(client);
    const hello = await client.start();
    if (recovery) {
      const snapshot = await client.request({ type: 'query', query_id: 'supervisor.resync', after_cursor: null });
      this.lastResync = snapshot;
      this.transition('resynced', { pid: client.child.pid });
    }
    this.transition('ready', { pid: client.child.pid });
    return hello;
  }

  async start() {
    this.transition('starting');
    const hello = await this.startClient();
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    return hello;
  }

  async heartbeatTick() {
    if (this.state !== 'ready' || this.heartbeatBusy || !this.client) return;
    this.heartbeatBusy = true;
    const client = this.client;
    let timeout;
    try {
      await Promise.race([
        client.request({ type: 'heartbeat' }, { timeoutMs: this.heartbeatTimeoutMs }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('HEARTBEAT_TIMEOUT')), this.heartbeatTimeoutMs); }),
      ]);
    } catch {
      if (client === this.client && client.child && client.child.exitCode === null) client.child.kill('SIGKILL');
    } finally {
      clearTimeout(timeout);
      this.heartbeatBusy = false;
    }
  }

  async handleDisconnect(client, event) {
    if (this.stopping || client !== this.client) return;
    this.crashCount += 1;
    this.transition('disconnected', event);
    if (this.restartCount >= 1) {
      this.transition('degraded_read_only', { reason: 'core_restart_budget_exhausted' });
      return;
    }
    this.restartCount += 1;
    this.transition('restarting', { attempt: this.restartCount });
    try { await this.startClient({ recovery: true }); }
    catch (error) { this.transition('degraded_read_only', { reason: error.message }); }
  }

  request(command, options) {
    if (this.state !== 'ready' || !this.client) throw new Error(`CORE_NOT_READY:${this.state}`);
    return this.client.request(command, options);
  }

  async waitForState(expected, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.state !== expected && Date.now() < deadline) {
      await Promise.race([new Promise((resolve) => this.waiters.push(resolve)), pause(50)]);
    }
    if (this.state !== expected) throw new Error(`CORE_STATE_TIMEOUT:${expected}:${this.state}`);
  }

  get child() { return this.client?.child; }
  get identity() { return this.client?.identity; }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    if (this.client?.child?.exitCode === null) await this.client.shutdown();
    this.checkpointKeyCustody.close();
    this.transition('stopped');
  }
}
