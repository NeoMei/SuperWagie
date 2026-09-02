import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Checker, argValue, writeResults, envFail, rmrf, sha256, walkFiles } from './lib.mjs';

const FIXTURE_ID = 'G1-WORKSPACE-001';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: workspace-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const metrics = {};
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g1-ws-'));

try {
  const root = path.join(tmpBase, 'workspace');
  fs.mkdirSync(root);

  // ---------- shared safe path layer ----------
  function resolveInside(base, rel) {
    if (typeof rel !== 'string' || rel.length === 0) throw new Error('bad-path');
    if (path.isAbsolute(rel)) throw new Error('escape:absolute');
    const resolved = path.resolve(base, rel);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && !resolved.startsWith(withSep)) throw new Error('escape:traversal');
    return resolved;
  }

  function realpathInside(base, rel) {
    const resolved = resolveInside(base, rel);
    let real;
    try {
      real = fs.realpathSync(resolved);
    } catch (e) {
      return resolved;
    }
    const rootReal = fs.realpathSync(base);
    const rootRealSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(rootRealSep)) throw new Error('escape:symlink');
    return real;
  }

  const tmpDir = path.join(root, '.superwagie-tmp');
  function safeWriteFile(base, rel, content, beforePublish) {
    const target = realpathInside(base, rel);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, crypto.randomUUID());
    fs.writeFileSync(tmp, content);
    if (beforePublish) beforePublish();
    let ok = false;
    try {
      realpathInside(base, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(tmp, target);
      ok = true;
    } finally {
      if (!ok) {
        try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
      }
    }
    return target;
  }

  // ---------- 1. root containment ----------
  safeWriteFile(root, 'docs/正常.md', 'hello');
  const escapeAttempts = ['../outside.txt', 'a/../../outside.txt', path.join(os.tmpdir(), 'superwagie-escape-probe.txt')];
  let rejected = 0;
  for (const attempt of escapeAttempts) {
    try {
      safeWriteFile(root, attempt, 'evil');
    } catch (e) {
      rejected++;
    }
  }
  const probeAbsent =
    !fs.existsSync(path.join(os.tmpdir(), 'superwagie-escape-probe.txt')) &&
    !fs.existsSync(path.join(tmpBase, 'outside.txt'));
  checker.check(
    'ws:root-containment',
    rejected === escapeAttempts.length && probeAbsent && fs.existsSync(path.join(root, 'docs/正常.md')),
    'rejected=' + rejected + '/' + escapeAttempts.length + ' probeAbsent=' + probeAbsent
  );

  // ---------- 2. symlink protection ----------
  const outsideDir = path.join(tmpBase, 'outside');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE-SECRET');
  fs.writeFileSync(path.join(root, 'real-a.md'), 'A');
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(root, 'link-out.md'));
  let symlinkRejections = 0;
  try { safeWriteFile(root, 'link-out.md', 'hack'); } catch (e) { symlinkRejections++; }
  try { realpathInside(root, 'link-out.md'); } catch (e) { symlinkRejections++; }
  fs.symlinkSync('real-a.md', path.join(root, 'link-in.md'));
  let internalSymlinkOk = false;
  try {
    safeWriteFile(root, 'link-in.md', 'B2');
    internalSymlinkOk = fs.readFileSync(path.join(root, 'real-a.md'), 'utf8') === 'B2';
  } catch (e) { /* should not happen */ }
  checker.check(
    'ws:symlink-escape-rejected',
    symlinkRejections === 2 &&
      fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8') === 'OUTSIDE-SECRET' &&
      internalSymlinkOk,
    'rejections=' + symlinkRejections + ' internalSymlinkWrite=' + internalSymlinkOk
  );

  // TOCTOU: flip symlink between resolution and publish
  fs.writeFileSync(path.join(root, 'swap-target.md'), 'ORIGINAL');
  fs.symlinkSync('swap-target.md', path.join(root, 'swap-link.md'));
  let swapped = false;
  let swapError = null;
  try {
    safeWriteFile(root, 'swap-link.md', 'EVIL', function () {
      if (!swapped) {
        swapped = true;
        fs.unlinkSync(path.join(root, 'swap-link.md'));
        fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(root, 'swap-link.md'));
      }
    });
  } catch (e) {
    swapError = e;
  }
  const swapGuardOk =
    swapError !== null && swapError.message === 'escape:symlink' &&
    fs.readFileSync(path.join(root, 'swap-target.md'), 'utf8') === 'ORIGINAL' &&
    fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8') === 'OUTSIDE-SECRET';
  checker.check('ws:symlink-swap-toctou-guard', swapGuardOk, 'error=' + (swapError ? swapError.message : 'none') + ' targetsUnchanged=' + swapGuardOk);

  // ---------- 3. case / unicode identity ----------
  fs.writeFileSync(path.join(root, 'Report.md'), 'A');
  let caseBehavior = 'coexisting';
  try {
    const p2 = path.join(root, 'report.md');
    if (fs.existsSync(p2)) throw new Error('case-collision');
    fs.writeFileSync(p2, 'B');
  } catch (e) {
    if (e.message === 'case-collision') caseBehavior = 'collision-detected';
  }
  const noOverwrite = fs.readFileSync(path.join(root, 'Report.md'), 'utf8') === 'A';
  const nfcName = 'café咖啡.md'.normalize('NFC');
  const nfdName = 'café咖啡.md'.normalize('NFD');
  const spellingsDiffer = nfcName !== nfdName;
  fs.writeFileSync(path.join(root, nfcName), 'x');
  const nfdLookup = fs.existsSync(path.join(root, nfdName));
  const realFile = fs.realpathSync(path.join(root, nfcName));
  const identityOk = path.basename(realFile).normalize('NFC') === nfcName.normalize('NFC');
  checker.check(
    'ws:case-unicode-identity',
    noOverwrite && spellingsDiffer && identityOk,
    'case=' + caseBehavior + ' nfdLookup=' + nfdLookup + ' noOverwrite=' + noOverwrite + ' identityOk=' + identityOk
  );

  // ---------- 4. long path / long filename ----------
  function makeRelPath(depth, fileName) {
    const parts = [];
    for (let i = 0; i < depth; i++) parts.push('目录-' + i + '-abcdefghijklmnopqrstuvwxyz');
    return parts.concat([fileName]).join('/');
  }
  let longOk = false;
  let achieved = 0;
  for (let depth = 22; depth >= 8; depth--) {
    try {
      const relP = makeRelPath(depth, '内容-' + '长'.repeat(60) + '.md');
      safeWriteFile(root, relP, 'deep');
      const back = fs.readFileSync(fs.realpathSync(path.join(root, relP)), 'utf8');
      longOk = back === 'deep';
      achieved = path.join(root, relP).length;
      break;
    } catch (e) { /* try shallower */ }
  }
  let nameRejected = false;
  try {
    // APFS 文件名上限为 255 个 UTF-16 码元；300 个 CJK 字符（900 UTF-8 字节）确保超过任何变体限制
    fs.writeFileSync(path.join(root, '长'.repeat(300) + '.md'), 'x');
  } catch (e) {
    nameRejected = e.code === 'ENAMETOOLONG';
  }
  checker.check('ws:longpath', longOk && achieved >= 500 && nameRejected, 'achievedAbsLen=' + achieved + ' oversizeNameRejected=' + nameRejected);

  // ---------- 5. external edit watcher ----------
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const index = new Map();
  function reindexFile(rel) {
    const st = fs.statSync(path.join(root, rel));
    index.set(rel.normalize('NFC'), { size: st.size, id: sha256(rel + ':' + st.size + ':' + st.mtimeMs).slice(0, 16) });
  }
  for (let i = 0; i < 5; i++) {
    const rn = 'notes/e' + i + '.md';
    safeWriteFile(root, rn, 'v1-' + i);
    reindexFile(rn);
  }
  const events = [];
  const watcher = fs.watch(root, { recursive: true }, function (evt, filename) {
    if (filename) events.push({ filename: filename.split(path.sep).join('/'), t: Date.now() });
  });
  await new Promise(function (r) { setTimeout(r, 300); });
  const tWrite = Date.now();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, 'notes/e' + i + '.md'), 'v2-' + i);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'CHANGED-OUTSIDE');
  await new Promise(function (r) { setTimeout(r, 2000); });
  const evFiles = events.map(function (e) { return e.filename; });
  let allFive = true;
  let maxLatency = 0;
  for (let i = 0; i < 5; i++) {
    const suffix = 'e' + i + '.md';
    const hit = evFiles.find(function (f) { return f.endsWith(suffix); });
    if (!hit) allFive = false;
    else maxLatency = Math.max(maxLatency, events.find(function (e) { return e.filename === hit; }).t - tWrite);
    reindexFile('notes/e' + i + '.md');
  }
  const noOutsideEvent = !evFiles.some(function (f) { return f.indexOf('outside') >= 0 || f.indexOf('secret') >= 0; });
  watcher.close();
  checker.check('ws:external-edit-watch', allFive && noOutsideEvent && maxLatency < 2000, 'allFive=' + allFive + ' maxLatencyMs=' + maxLatency + ' outsideLeak=' + !noOutsideEvent);

  // ---------- 6. scale baselines ----------
  async function createScaleTree(base, n) {
    fs.mkdirSync(base, { recursive: true });
    const dirs = Math.max(1, Math.ceil(n / 400));
    for (let d = 0; d < dirs; d++) fs.mkdirSync(path.join(base, 'd' + d));
    let counter = 0;
    async function worker() {
      for (;;) {
        const idx = counter++;
        if (idx >= n) return;
        await fs.promises.writeFile(path.join(base, 'd' + (idx % dirs), 'f' + idx + '.md'), 'scale ' + idx);
      }
    }
    await Promise.all(Array.from({ length: 64 }, function () { return worker(); }));
  }

  function scanIndexSync(base) {
    const files = walkFiles(base);
    const map = new Map();
    for (const rel of files) {
      const st = fs.statSync(path.join(base, rel));
      map.set(rel.normalize('NFC'), { size: st.size, id: sha256(rel + ':' + st.size).slice(0, 16) });
    }
    return map;
  }

  async function scanIndexAsync(base, signal) {
    const files = walkFiles(base);
    const map = new Map();
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) return { cancelled: true };
      const rel = files[i];
      const st = fs.statSync(path.join(base, rel));
      map.set(rel.normalize('NFC'), { size: st.size, id: sha256(rel + ':' + st.size).slice(0, 16) });
      if (i % 2000 === 0) await new Promise(function (r) { setImmediate(r); });
    }
    return { cancelled: false, count: map.size };
  }

  async function incremental(base, count, tag) {
    const files = walkFiles(base).filter(function (f) { return f.endsWith('.md'); }).slice(0, count);
    const lastEvent = new Map();
    const w = fs.watch(base, { recursive: true }, function (evt, filename) {
      if (filename) lastEvent.set(filename.split(path.sep).join('/'), Date.now());
    });
    const times = new Map();
    for (let i = 0; i < files.length; i++) {
      times.set(files[i], Date.now());
      fs.writeFileSync(path.join(base, files[i]), 'inc ' + tag + ' ' + i);
    }
    await new Promise(function (r) { setTimeout(r, 1200); });
    w.close();
    const lat = [];
    for (const f of files) {
      let ev = null;
      for (const [k, v] of lastEvent) {
        if (k.endsWith(path.basename(f))) { ev = v; break; }
      }
      lat.push((ev == null ? Date.now() : ev) - times.get(f));
    }
    lat.sort(function (a, b) { return a - b; });
    return { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.max(0, Math.ceil(lat.length * 0.95) - 1)] };
  }

  const specs = [
    { n: 1000, tag: '1k', coldLimit: 2000 },
    { n: 10000, tag: '10k', coldLimit: 10000 },
    { n: 100000, tag: '100k', coldLimit: 60000 }
  ];
  for (const spec of specs) {
    const base = path.join(tmpBase, 'scale-' + spec.tag);
    await createScaleTree(base, spec.n);
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    const idx = scanIndexSync(base);
    const cold = Date.now() - t0;
    const cpuDelta = process.cpuUsage(cpu0);
    const inc = await incremental(base, 50, spec.tag);
    const m = {
      files: idx.size,
      coldStartMs: cold,
      incrementalP50Ms: inc.p50,
      incrementalP95Ms: inc.p95,
      cpuUserMs: Math.round(cpuDelta.user / 1000),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576)
    };
    if (spec.tag === '100k') {
      const controller = new AbortController();
      const t1 = Date.now();
      const scanPromise = scanIndexAsync(base, controller.signal);
      setTimeout(function () { controller.abort(); }, 300);
      const part = await scanPromise;
      m.cancelStopMs = Date.now() - t1;
      m.cancelled = part.cancelled;
    }
    metrics[spec.tag] = m;
    rmrf(base);
    const passScale =
      idx.size >= spec.n && cold < spec.coldLimit && inc.p95 < 1000 &&
      (spec.tag !== '100k' || (m.cancelled === true && m.cancelStopMs < 1500));
    checker.check(
      'ws:scale-' + spec.tag,
      passScale,
      spec.tag + ' files=' + idx.size + ' cold=' + cold + 'ms p95=' + inc.p95 + 'ms' +
        (m.cancelStopMs != null ? ' cancelStop=' + m.cancelStopMs + 'ms cancelled=' + m.cancelled : '')
    );
  }

  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, 'scale-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  }
} finally {
  rmrf(tmpBase);
}

const pass = writeResults(resultsPath, {
  gate: 'gate-1',
  fixture: FIXTURE_ID,
  startedAt: startedAt,
  checker: checker,
  decisionHint: 'GO',
  metrics: metrics
});
process.exitCode = pass ? 0 : 1;
