import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { joinRuntimePath, runtimePlatform } from '../src/runtime-platform.mjs';

const spikeRoot = resolve(import.meta.dirname, '..');
const platform = runtimePlatform();
const electron = joinRuntimePath(spikeRoot, platform.developmentElectron);
const core = joinRuntimePath(spikeRoot, platform.coreDebug);
const main = join(spikeRoot, 'src', 'electron-main.mjs');

test('actual Electron shell isolates surfaces and recovers only failed domains', { timeout: 120_000 }, () => {
  assert.ok(existsSync(main), 'actual Electron main entrypoint must exist');
  const runRoot = mkdtempSync(join(tmpdir(), 'superwagie-solution-b-test-'));
  const resultPath = join(runRoot, 'result.json');
  const run = spawnSync(electron, [main, '--self-test', '--output', resultPath], {
    cwd: spikeRoot,
    encoding: 'utf8',
    timeout: 110_000,
    env: {
      ...process.env,
      SUPERWAGIE_ENV_CANARY: 'must-not-cross-worker-boundary',
      CODEX_HOME: join(runRoot, 'forbidden-codex-home'),
      HTTPS_PROXY: 'http://forbidden.proxy.invalid',
      SUPERWAGIE_CORE_BIN: core,
      SUPERWAGIE_SPIKE_ROOT: spikeRoot,
      SUPERWAGIE_RUN_ROOT: runRoot,
    },
  });
  assert.equal(run.status, 0, `Electron spike must exit 0\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.deepEqual(result.identity, {
    electron: '44.1.0',
    chromium: '152.0.7977.65',
    node: '24.19.0',
    rust_protocol: 'solution-b-v1',
  });
  assert.equal(result.core.actual_binary, true);
  assert.equal(result.core.handshake, true);
  assert.equal(result.core.heartbeat, true);
  assert.equal(result.core.query_snapshot, true);
  assert.equal(result.core.resource_handle, true);
  assert.equal(result.core.safe_checkpoint, true);
  assert.equal(result.core.checkpoint_key_fd_custody, true);
  assert.equal(existsSync(`${join(runRoot, 'core-checkpoint.json')}.auth-key`), false);
  assert.equal(result.core.authenticated_envelopes, true);

  assert.deepEqual(result.surfaces.map(({ type }) => type).sort(), [
    'app_ui',
    'artifact_preview',
    'diagram_editor',
  ]);
  assert.equal(new Set(result.surfaces.map(({ partition }) => partition)).size, 3);
  for (const surface of result.surfaces) {
    assert.equal(surface.ephemeral, true);
    assert.deepEqual(surface.web_preferences, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
    assert.equal(surface.node_unreachable, true);
    assert.equal(surface.raw_ipc_unreachable, true);
    assert.equal(surface.navigation_denied, true);
    assert.equal(surface.window_open_denied, true);
    assert.equal(surface.permission_denied, true);
    assert.equal(surface.download_denied, true);
    assert.equal(surface.remote_request_count, 0);
  }
  assert.equal(result.isolation.cross_surface_storage_leaks, 0);
  assert.equal(result.isolation.destroyed_surface_storage_leaks, 0);
  assert.equal(result.isolation.handle_transfer_rejected, true);
  assert.equal(result.isolation.forged_handle_rejected, true);
  assert.deepEqual(result.isolation.ipc_forgery, {
    unknown_field_rejected: true,
    wrong_identity_rejected: true,
    wrong_nonce_rejected: true,
    expired_rejected: true,
    replay_rejected: true,
    wrong_surface_channel_rejected: true,
    non_main_frame_rejected: true,
    core_queries_unchanged: true,
  });

  assert.equal(result.recovery.renderer_snapshot_resync, true);
  assert.equal(result.recovery.worker_job_only, true);
  assert.equal(result.recovery.worker_unexpected_exit_recovered, true);
  assert.equal(result.recovery.worker_restart_budget_exhausted, true);
  assert.equal(result.recovery.worker_spawn_error_reconciled, true);
  assert.equal(result.recovery.worker_hung_timeout_recovered, true);
  assert.equal(result.recovery.worker_cancel_shutdown_not_retried, true);
  assert.equal(result.recovery.worker_post_crash_checkpoint_tamper_rejected, true);
  assert.deepEqual(result.recovery.worker_reconcile_records.spawn_error.map(({ kind }) => kind), ['spawn_error', 'exit']);
  assert.deepEqual(result.recovery.worker_reconcile_records.hung_timeout.map(({ kind }) => kind), ['timeout', 'exit']);
  assert.deepEqual(result.recovery.worker_reconcile_records.cancelled.map(({ kind }) => kind), ['cancelled']);
  assert.deepEqual(result.recovery.worker_reconcile_records.post_crash_tamper.map(({ checkpoint_root_mismatch }) => checkpoint_root_mismatch), [false, true]);
  assert.equal(result.recovery.core_disconnected_observed, true);
  assert.equal(result.recovery.core_restart_count, 1);
  assert.equal(result.recovery.second_core_crash_degraded_read_only, true);
  assert.equal(result.recovery.ui_disconnected_then_resynced, true);
  assert.equal(result.recovery.parent_death_safe_exit, true);

  assert.equal(result.render_worker.independent_electron_host, true);
  assert.notEqual(result.render_worker.host_pid, result.processes.electron_main_pid);
  assert.deepEqual(result.render_worker.frame_indices, [0, 1, 2]);
  assert.equal(result.render_worker.hashes_run_1.length, 3);
  assert.deepEqual(result.render_worker.hashes_run_1, result.render_worker.hashes_run_2);
  assert.deepEqual(result.render_worker.hashes_run_1, result.render_worker.hashes_after_crash_recovery);
  assert.equal(result.render_worker.absolute_frame_driven, true);
  assert.equal(result.render_worker.signed_composition_verified, true);
  assert.equal(result.render_worker.remote_request_count, 0);
  assert.equal(result.render_worker.all_scheme_network_attempts > 0, true);
  assert.equal(result.render_worker.environment_from_empty_whitelist, true);
  assert.equal(result.render_worker.host_secret_canary_visible, false);
  assert.equal(result.render_worker.execution_manifest_verified, true);
  assert.equal(result.render_worker.checkpoint_pngs_recomputed, true);
  assert.equal(result.render_worker.checkpoint_root_source, 'worker_authenticated_progress_receipt');
  assert.equal(result.render_worker.post_crash_checkpoint_rehashes, 0);
  assert.equal(result.render_worker.authenticated_progress_receipt_verified, true);

  assert.equal(result.scope.platform, platform.id);
  assert.equal(result.scope.fixture, platform.fixture);
  assert.equal(result.scope.parent_fixture, 'G0-SHELL-002');
  assert.equal(result.scope.admission_effect, 'none');
  assert.equal(result.scope.signed, false);
  assert.ok(result.metrics.cold_start_ms > 0);
  assert.ok(result.metrics.frame_throughput_fps > 0);
  assert.ok(result.metrics.output_sha256_count >= 3);
  assert.ok(result.metrics.idle_main_memory_rss_bytes > 0);
  assert.ok(result.metrics.peak_observed_main_memory_rss_bytes >= result.metrics.idle_main_memory_rss_bytes);
  assert.ok(result.metrics.peak_observed_worker_memory_rss_bytes > 0);
  assert.ok(result.metrics.peak_observed_worker_process_tree_rss_bytes >= result.metrics.peak_observed_worker_memory_rss_bytes);
  assert.ok(result.metrics.worker_process_tree_types.includes('Browser'));
  assert.ok(result.metrics.worker_process_tree_types.includes('Tab'));
  assert.ok(result.metrics.renderer_destroy_to_resynced_ready_ms > 0);
  assert.ok(result.metrics.core_crash_observed_to_ready_ms > 0);
  assert.ok(result.metrics.worker_resume_render_loop_ms > 0);
  assert.ok(result.metrics.worker_crash_observed_to_ready_ms >= result.metrics.worker_resume_render_loop_ms);
  assert.equal(result.metrics.worker_remote_requests_allowed, 0);
  assert.ok(result.metrics.worker_remote_requests_blocked > 0);
  assert.equal(result.processes.records.rust_core.length, 2);
  assert.deepEqual(result.processes.records.render_workers.map(({ exit_code }) => exit_code), [0, 0, process.platform === 'win32' ? 1 : null, 0, 1, 1]);
  assert.equal(result.processes.records.render_workers[2].signal, 'SIGKILL');
});
