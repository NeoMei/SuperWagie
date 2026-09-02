import { app, protocol } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CoreSupervisor } from '../../solution-b-spike/src/core-supervisor.mjs';
import { SurfaceManager } from '../../solution-b-spike/src/surface-manager.mjs';
import { prepareReviewRenderJob, runPreparedReviewJob, sha256 } from './task7-worker-protocol.mjs';
import { measureWpsIdentity, runWpsConversion, probePdfPageCount } from './task7-wps-truth.mjs';
import {
  classifyArtifact, reanchorAnnotations, ReviewPageCache, ReviewStateStore, searchTextLayer,
} from './task7-lib.mjs';

protocol.registerSchemesAsPrivileged([{
  scheme: 'superwagie-app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
}]);
app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const writeJson = (path, value) => {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
const readRenderResult = (jobRoot) => JSON.parse(readFileSync(join(jobRoot, 'outputs', 'result.json'), 'utf8'));

const FIXTURES = Object.freeze({
  docx30p: {
    name: 'reviewer-torture-30p.docx',
    path: 'fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-30p.docx',
    sha256: 'b32ce53325eefa039baddba62569c9db0e0f77e70ca681f04fd88e7347441a8a',
    declared: 30,
  },
  pptx20s: {
    name: 'reviewer-torture-20s.pptx',
    path: 'fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-20s.pptx',
    sha256: '46f64fad242ecfc27350974c4e04c64c83a105c74f2cdd610eec087039f78d48',
    declared: 20,
  },
  pdf100p: {
    name: 'reviewer-torture-100p.pdf',
    path: 'fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-100p.pdf',
    sha256: 'cb17b352b21ffc3e4286d5ffbdcbecb7a2f262ff41edca9eb1d514b5091f2b22',
    declared: 100,
  },
  corruptPdf: {
    name: 'corrupt-tail.pdf',
    path: 'fixtures/gate-3/G3-REVIEW-001/fixtures/corrupt-tail.pdf',
    sha256: '3fbff3c5331593df541d3931a8b4f74cdbb7bd86ad6a14da01e35602ae1d5edc',
  },
  oversizeBin: {
    name: 'oversize-placeholder.bin',
    path: 'fixtures/gate-3/G3-REVIEW-001/fixtures/oversize-placeholder.bin',
    sha256: 'f73bdcc986c8bfb694a6b5ff105ba2205ddc907baa3399af668e083d93084a13',
  },
});

async function runReviewHost() {
  const outputPath = valueAfter('--output');
  const repoRoot = resolve(valueAfter('--repo-root'));
  const candidateRoot = resolve(valueAfter('--candidate-root'));
  const runRoot = resolve(valueAfter('--run-root'));
  if (!outputPath || !repoRoot || !candidateRoot || !runRoot) {
    throw new Error('review host requires --output --repo-root --candidate-root --run-root');
  }
  const coreBinary = join(candidateRoot, 'core', 'target', 'release', 'solution-b-core');
  const spikeRoot = join(repoRoot, 'scripts', 'poc', 'solution-b-spike');
  const candidateElectron = join(candidateRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const candidateManifest = join(candidateRoot, 'runtime-manifest.json');
  const runNonce = valueAfter('--run-nonce') ?? process.pid.toString();
  const checkpointPath = join(runRoot, 'core-checkpoint.json');

  const identity = {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    candidate_electron_sha256: sha256(readFileSync(candidateElectron)),
    candidate_manifest_sha256: sha256(readFileSync(candidateManifest)),
    core_binary_sha256: sha256(readFileSync(coreBinary)),
  };

  let surfaces;
  const core = new CoreSupervisor({
    binary: coreBinary,
    checkpointPath,
    onState: (event) => { surfaces?.setCoreStatus(event.state).catch(() => {}); },
  });
  const coreHello = await core.start();
  const coreInitialPid = core.child.pid;
  const coreSnapshot = await core.request({ type: 'query', query_id: 'review.snapshot', after_cursor: null });

  surfaces = new SurfaceManager({ root: spikeRoot, core });
  const preview = await surfaces.create('artifact_preview');
  const previewExercise = await surfaces.exercise(preview);

  const fixtures = {};
  for (const [key, fixture] of Object.entries(FIXTURES)) {
    const bytes = readFileSync(join(repoRoot, fixture.path));
    const actualSha = sha256(bytes);
    fixtures[key] = {
      name: fixture.name,
      hash_matches: actualSha === fixture.sha256,
      classification: classifyArtifact({
        name: fixture.name, bytes,
        maxBytes: key === 'oversizeBin' ? 1024 : 64 * 1024 * 1024,
      }),
    };
  }

  const fastPreview = {};
  const docxFastJob = prepareReviewRenderJob({
    repositoryRoot: repoRoot, candidateRoot, workRoot: join(runRoot, 'fast'), jobId: 'fast-docx-30p',
    kind: 'docx', sourcePath: join(repoRoot, FIXTURES.docx30p.path), sourceSha256: FIXTURES.docx30p.sha256,
    declaredPageCount: FIXTURES.docx30p.declared, pageIndices: [1, 2, 3], scale: 1, zoomVariants: [1, 1.5],
  });
  const docxFast = await runPreparedReviewJob(docxFastJob, { timeoutMs: 90_000 });
  if (docxFast.cleanExit) {
    const result = readRenderResult(docxFastJob.jobRoot);
    fastPreview.docx = {
      clean: true,
      declared: result.declaredPageCount,
      rendered: result.renderedPageCount,
      repaginated: result.repaginated,
      requested_fonts: result.requestedFonts,
      text_items_page_1: result.textItemCounts['1'],
      zoom_variants: result.zoomArtifacts.map((z) => z.zoom),
      elapsed_ms: Math.round(result.elapsedMs),
    };
  } else {
    fastPreview.docx = { clean: false, error: docxFast.error };
  }

  const pdfFastJob = prepareReviewRenderJob({
    repositoryRoot: repoRoot, candidateRoot, workRoot: join(runRoot, 'fast'), jobId: 'fast-pdf-100p',
    kind: 'pdf', sourcePath: join(repoRoot, FIXTURES.pdf100p.path), sourceSha256: FIXTURES.pdf100p.sha256,
    declaredPageCount: FIXTURES.pdf100p.declared, pageIndices: [1, 2, 3], scale: 1, zoomVariants: [1, 1.5],
  });
  const pdfFast = await runPreparedReviewJob(pdfFastJob, { timeoutMs: 90_000 });
  if (pdfFast.cleanExit) {
    const result = readRenderResult(pdfFastJob.jobRoot);
    fastPreview.pdf = {
      clean: true,
      declared: result.declaredPageCount,
      rendered: result.renderedPageCount,
      repaginated: result.repaginated,
      text_items_page_1: result.textItemCounts['1'],
      zoom_variants: result.zoomArtifacts.map((z) => z.zoom),
      elapsed_ms: Math.round(result.elapsedMs),
    };
  } else {
    fastPreview.pdf = { clean: false, error: pdfFast.error };
  }

  const wpsIdentityResult = await measureWpsIdentity({ repositoryRoot: repoRoot });
  const wpsTruth = { identity_result: wpsIdentityResult };
  if (wpsIdentityResult.ok) {
    const docxConversion = await runWpsConversion({
      repositoryRoot: repoRoot, workRoot: join(runRoot, 'wps'), jobId: 'docx-30p-truth',
      sourcePath: join(repoRoot, FIXTURES.docx30p.path), sourceSha256: FIXTURES.docx30p.sha256,
      identity: wpsIdentityResult.identity,
    });
    wpsTruth.docx = docxConversion.ok ? {
      ok: true,
      output_sha256: docxConversion.output.sha256,
      bytes: docxConversion.output.bytes,
      duration_ms: docxConversion.worker.duration_ms,
      page_count: await probePdfPageCount({ repositoryRoot: repoRoot, pdfPath: docxConversion.output.path }),
    } : { ok: false, failure: docxConversion.failure };

    const pptxConversion = await runWpsConversion({
      repositoryRoot: repoRoot, workRoot: join(runRoot, 'wps'), jobId: 'pptx-20s-truth',
      sourcePath: join(repoRoot, FIXTURES.pptx20s.path), sourceSha256: FIXTURES.pptx20s.sha256,
      identity: wpsIdentityResult.identity,
    });
    wpsTruth.pptx = pptxConversion.ok ? {
      ok: true,
      output_sha256: pptxConversion.output.sha256,
      bytes: pptxConversion.output.bytes,
      duration_ms: pptxConversion.worker.duration_ms,
      page_count: await probePdfPageCount({ repositoryRoot: repoRoot, pdfPath: pptxConversion.output.path }),
    } : { ok: false, failure: pptxConversion.failure };
  }

  const stateStore = new ReviewStateStore({
    journalPath: join(runRoot, 'review-state.json'), key: 'f'.repeat(64),
  });
  const annotation = {
    annotationId: 'annotation-0f0e0d0c-1111-4222-8333-444455556666',
    pageId: 'page-2',
    contextDigest: 'sha256:' + 'a'.repeat(64),
    bbox: [0.1, 0.2, 0.3, 0.4],
    status: 'active',
  };
  stateStore.checkpoint({
    revision: 7, preview_revision_id: 'preview-sha256:' + '1'.repeat(64),
    accepted_revision: 7, annotations: [annotation],
    effects: { accepted: 1, published: 1, applied: ['accept:revision-7'] },
  });

  const pageCache = new ReviewPageCache();
  const cacheBytes = readFileSync(join(docxFastJob.jobRoot, 'outputs', 'pages', 'page-0001.png'));
  pageCache.put('docx-fast/page-1', { bytes: Buffer.from(cacheBytes) });
  pageCache.put('docx-fast/page-2', { bytes: Buffer.from(cacheBytes) });
  pageCache.corruptForTest('docx-fast/page-1');
  const cacheCorrupt = pageCache.get('docx-fast/page-1');
  const cacheNeighbor = pageCache.get('docx-fast/page-2');

  const surfaceRecoveryStarted = performance.now();
  const destroyedPreview = await surfaces.destroy('artifact_preview');
  const recreatedPreview = await surfaces.create('artifact_preview');
  const recreatedProbe = await recreatedPreview.webContents.executeJavaScript('window.__surfaceProbe()');
  const surfaceRecoveryMs = performance.now() - surfaceRecoveryStarted;
  const coreStateAfterSurfaceRecreate = await core.request({ type: 'query', query_id: 'review.snapshot', after_cursor: null });

  const coreRecoveryStarted = performance.now();
  const killedCorePid = core.child.pid;
  core.child.kill('SIGKILL');
  while (!core.history.some((event) => event.state === 'disconnected' && event.pid === killedCorePid)) await pause(10);
  await core.waitForState('ready');
  const coreRecoveryMs = performance.now() - coreRecoveryStarted;
  const coreSnapshotAfterRestart = await core.request({ type: 'query', query_id: 'review.snapshot', after_cursor: null });

  const renderCrashJob = prepareReviewRenderJob({
    repositoryRoot: repoRoot, candidateRoot, workRoot: join(runRoot, 'recovery'), jobId: 'recovery-crash-pdf',
    kind: 'pdf', sourcePath: join(repoRoot, FIXTURES.pdf100p.path), sourceSha256: FIXTURES.pdf100p.sha256,
    declaredPageCount: FIXTURES.pdf100p.declared, pageIndices: [1, 2, 3, 4, 5], scale: 1, zoomVariants: [1],
    crashAfterPages: 2, crashMode: 'exit86',
  });
  const renderCrash = await runPreparedReviewJob(renderCrashJob, { timeoutMs: 90_000 });

  const wpsMissing = wpsIdentityResult.ok ? await runWpsConversion({
    repositoryRoot: repoRoot, workRoot: join(runRoot, 'wps-recovery'), jobId: 'wps-missing',
    sourcePath: join(repoRoot, FIXTURES.docx30p.path), sourceSha256: FIXTURES.docx30p.sha256,
    identity: wpsIdentityResult.identity, wpsApplication: '/Applications/definitely-missing-wps.app',
  }) : null;

  const stateAfterRecovery = stateStore.load();
  const reanchor = reanchorAnnotations({
    annotations: [annotation],
    old_manifest: { pages: [{ pageId: 'page-2', contextDigests: [annotation.contextDigest] }] },
    new_manifest: { pages: [{ pageId: 'page-5', contextDigests: [annotation.contextDigest] }] },
  });

  const result = {
    schema_id: 'superwagie.solution-b-task7-review-host.v1',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_nonce: runNonce,
    identity,
    fixtures,
    surface_isolation: {
      type: previewExercise.type,
      node_unreachable: previewExercise.node_unreachable,
      raw_ipc_unreachable: previewExercise.raw_ipc_unreachable,
      navigation_denied: previewExercise.navigation_denied,
      window_open_denied: previewExercise.window_open_denied,
      permission_denied: previewExercise.permission_denied,
      download_denied: previewExercise.download_denied,
      remote_request_count: previewExercise.remote_request_count,
    },
    fast_preview: fastPreview,
    wps_truth: wpsTruth,
    interactions: {
      search: searchTextLayer([{ page: 2, items: [{ text: 'SuperWagie Review', bbox: [0.1, 0.1, 0.2, 0.05] }] }], 'review'),
      reanchor,
    },
    cache: {
      corrupt_entry_rejected: cacheCorrupt.ok === false && cacheCorrupt.code === 'CACHE_ENTRY_CORRUPT',
      neighbor_preserved: cacheNeighbor.ok === true,
      stats: pageCache.stats(),
    },
    recovery: {
      surface: {
        destroyed: destroyedPreview.destroyed,
        recreated_identity: recreatedPreview.identity,
        fresh_domain_state: recreatedProbe.initialDomainState === null,
        duration_ms: surfaceRecoveryMs,
        core_state_preserved: coreStateAfterSurfaceRecreate.snapshot_revision === coreSnapshot.snapshot_revision,
      },
      core: {
        killed_pid: killedCorePid,
        restarted_pid: core.child.pid,
        duration_ms: coreRecoveryMs,
        snapshot_restored: coreSnapshotAfterRestart.snapshot_revision === coreSnapshot.snapshot_revision,
      },
      render_host: {
        clean: renderCrash.cleanExit,
        recovered: renderCrash.recoveredFromCrash,
        attempts: renderCrash.attempts,
        first_crash_code: renderCrash.executions?.[0]?.code,
      },
      wps_missing: wpsMissing ? {
        status: wpsMissing.receipt?.status,
        code: wpsMissing.receipt?.code,
        graceful_degradation: wpsMissing.receipt?.status === 'dependency_missing',
      } : null,
      state: {
        revision_survived: stateAfterRecovery.ok && stateAfterRecovery.state.revision === 7,
        annotations_survived: stateAfterRecovery.ok && stateAfterRecovery.state.annotations.length === 1,
        no_duplicate_effects: stateAfterRecovery.ok && stateAfterRecovery.state.effects.accepted === 1,
      },
    },
    processes: {
      electron_main_pid: process.pid,
      rust_core_pids: [coreInitialPid, core.child.pid],
      core_restart_count: core.restartCount,
      core_handshake_identity: coreHello.identity,
    },
    scope: {
      evidence_version: 'solution-b-task7-v1',
      platform: 'macos-15-arm64',
      parent_fixtures: ['G3-REVIEW-001', 'G3-REVIEW-002'],
      admission_effect: 'none',
      signed: false,
    },
  };

  writeJson(outputPath, result);
  process.stdout.write(JSON.stringify({ event: 'review-host-complete', run_nonce: runNonce, pass: true }) + '\n');
  await surfaces.closeAll();
  await core.shutdown();
}

app.whenReady().then(async () => {
  if (process.arch !== 'arm64' || process.platform !== 'darwin') throw new Error('macos-arm64 only');
  if (process.versions.electron !== '44.1.0') throw new Error('electron identity mismatch');
  await runReviewHost();
  app.quit();
}).catch((error) => {
  console.error(error.stack ?? error);
  app.exit(1);
});
