import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CoreClient, canonicalJson } from '../src/main/core-client.mjs';
import { CoreSupervisor } from '../src/main/core-supervisor.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = join(appRoot, '..', '..', 'crates', 'product-core', 'target', 'debug', 'superwagie-product-core');

test('canonical JSON is stable across object insertion order', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), canonicalJson({ a: { b: 3, y: 2 }, z: 1 }));
});

test('actual Rust core authenticates, responds, and checkpoints its shutdown', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'superwagie-core-client-'));
  const client = new CoreClient({ binary, stateRoot });
  try {
    const identity = await client.start();
    assert.equal(identity.identity, 'superwagie-rust-product-core');
    assert.deepEqual(await client.request({ type: 'heartbeat' }), { status: 'alive' });
    assert.deepEqual(await client.request({ type: 'shell_select', selected_root: null }), { status: 'cancelled' });
    await assert.rejects(
      Promise.resolve().then(() => client.request({ type: 'heartbeat', padding: 'x'.repeat(1024 * 1024) })),
      /CORE_REQUEST_TOO_LARGE/,
    );
    await client.shutdown();
    assert.notEqual(client.child.exitCode, null);
  } finally {
    await client.forceStop();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('one core crash reopens the active grant and requires a fresh snapshot', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'superwagie-supervisor-state-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'superwagie-supervisor-project-'));
  writeFileSync(join(projectRoot, '正文.md'), 'restart body');
  const states = [];
  const supervisor = new CoreSupervisor({ binary, stateRoot, onState: (event) => states.push(event) });
  try {
    await supervisor.start();
    const selected = await supervisor.request({ type: 'shell_select', selected_root: projectRoot });
    supervisor.client.child.kill('SIGKILL');
    const deadline = Date.now() + 5_000;
    while ((supervisor.state !== 'ready' || supervisor.restartCount !== 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(supervisor.state, 'ready');
    assert.ok(states.some((event) => event.state === 'resync_required' && event.reason === 'core_restarted'));
    const projects = await supervisor.request({
      type: 'query',
      request: {
        protocol_version: 1, message_type: 'query.execute', request_id: 'request:after-restart', query_id: 'project.list', params: {},
      },
    });
    assert.equal(projects.payload.items[0].project_id, selected.project_id);
  } finally {
    await supervisor.shutdown();
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
