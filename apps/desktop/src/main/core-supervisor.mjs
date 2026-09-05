import { CoreClient } from './core-client.mjs';

export class CoreSupervisor {
  constructor({ binary, stateRoot, onState = () => {} }) {
    this.binary = binary;
    this.stateRoot = stateRoot;
    this.onState = onState;
    this.state = 'created';
    this.restartCount = 0;
    this.stopping = false;
  }

  transition(state, details = {}) {
    this.state = state;
    this.onState({ state, ...details });
  }

  async startClient(recovery = false) {
    let client;
    client = new CoreClient({
      binary: this.binary,
      stateRoot: this.stateRoot,
      onDisconnected: (event) => this.handleDisconnect(client, event),
    });
    this.client = client;
    const identity = await client.start();
    if (recovery) this.transition('resync_required', { reason: 'core_restarted' });
    this.transition('ready', { pid: client.child.pid });
    return identity;
  }

  async start() {
    this.transition('starting');
    return this.startClient(false);
  }

  async handleDisconnect(client, event) {
    if (this.stopping || client !== this.client) return;
    this.transition('disconnected', event);
    if (this.restartCount >= 1) {
      this.transition('degraded_read_only', { reason: 'core_restart_budget_exhausted' });
      return;
    }
    this.restartCount += 1;
    this.transition('restarting', { attempt: this.restartCount });
    try {
      await this.startClient(true);
    } catch (error) {
      this.transition('degraded_read_only', { reason: error.message });
    }
  }

  request(command, options) {
    if (this.state !== 'ready' || !this.client) throw new Error(`CORE_NOT_READY:${this.state}`);
    return this.client.request(command, options);
  }

  async shutdown() {
    this.stopping = true;
    if (this.client) await this.client.shutdown();
    this.transition('stopped');
  }
}
