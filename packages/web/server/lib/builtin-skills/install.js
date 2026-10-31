import fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertDestination, refreshManagedTree, statOrNull } from './managed-tree.js';
import { assertPresentationTarget, isImagePlaceholder, exposePresentationSkill, presentationCommand } from './presentation-runtime.js';
import legacyIdentities from './legacy-identities.json' with { type: 'json' };
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';


const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Only these byte-identical shipped readers may be refreshed. Other skill
// content, modified readers and skills in another host's directory stay owned
// by the user. Updating a helper first preserves the old adapters during a
// partially completed refresh, and every adapter refresh is retryable.
const MODEL_READER_BASELINES = {
  'ai-image-to-ppt': {
    "scripts/provider_credentials.py": ["aa7652a595e5bdf4da546ef4e3455781598f3541126cefa824a82c03b2d8c223", "779c7b687a5c54b9d908828a1a7c97d5fc2d37284646f10f0f475af9e3e549fd", "eae6d80ddb8bc792db19cce6dc7a64abb6166d10d5d1b4aa203b2be07e415f04", "86e122d85ca41ea10a51e3868bfecca597774f5492a3d0cde53f615d9fd778cf"],
    "scripts/gen_slide.py": "35ff14e87e0b48004604526240006cd7696a21abb8dee08710502fe3e8e04eda",
    "scripts/gen_slide_openai.py": "76218e38840b87844101408df244b8004a9fdfbdf81336fca0b8363bb833039d",
    "scripts/gen_slide_gemini.py": "91107d27faae0863be3aaeda44e2c1f437f2f891c61d56c3089882e432d3c9b0",
    "scripts/gen_slide_doubao.py": "a2effcc99abcec44f34d2d0853b8d81197f9487a74240b2398f5e8c5370e88f3"
},
  supervideo: { 'scripts/video.mjs': '941d44de8c1c2bc61886e5dffb5a71008d21ba487cd91a58d13d08fef1531827', 'runtime.lock.json': ['2a69e8230265b5931baa0b0b7c309f5384bd444063484eeb0f9742f1a7b52b0c', '360426fbac3400a61b6df1a0167bf60d8ccacfdb55ca07d741459b392972eb8e', 'e5d8842a4f1bd4881210636480dc7d3eabdddefad0e4e46061c31c42736144ac', '28164ef0767741f22d09edb6a3a486728e21fe55bf6d4f02fadac5f32247da02', '8c37b9da179641881bc544b9e1dfbfd99bb1f6d5210529395a2e0b65ef6c173d', '4f54359ef1eb9797ab17f2b7572857f2dbb6671dd616ed1a841f111101b55e3f', '6aa1a582c79fad7a16ac836ee3e71dc9038696c81516c19600dafbbf9687fb3b', '5f4ae89ca94b53a5e77992fc94f98963c3af575ab1988281cdb1a2fedf34a093', '8009945febfa5f1026af87e134effb21ee7cce94fa2e3f91f6a46c48cd45e873', 'b1527449df693920206b002b8a15eabfa3424f5cb14490438ae9d700ff582da3'] },
  'managed-image-edit': {
    'scripts/edit.mjs': ['776b0206804687c8a5e24abc7446617bb0aeb6649906e9d35546aaa8d67e8eb5', '188752c9dcfe56166e42b9499bc21aa5c95342718b73c6fcf3fbb9ea398c72f6'],
    'SKILL.md': 'df281ab3fdd2ee4f21e3dc84f9ac214591f0ced5d863fba772a6c32cb980a994',
  },
};

// Vision QA was added to the managed reader after the original image
// generators. A custom or absent QA helper must not block their migration.
const OPTIONAL_MODEL_READER_BASELINES = {
  'ai-image-to-ppt': {
    'scripts/vision_check_gemini.py': '9fcf939d5922f4651b089c3126ba9c6d4c9d380a980f0a407814738642d693c5',
  },
};

const assertConfinedDestination = async (root, target) => {
  const relativePath = path.relative(path.resolve(root), path.resolve(target));
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) throw new Error('Destination escapes its managed directory');
  let current = path.resolve(root);
  for (const part of ['', ...relativePath.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Managed destination contains a symbolic link');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
};

const refreshModelReaders = async ({ sourceDir, skillDir, warn, skipSupervideo = false, onlySupervideo = false, expectedSupervideoLock }) => {
  const updated = [];
  const groups = [
    ...Object.entries(MODEL_READER_BASELINES).map(([name, baselines]) => ({ name, baselines, optional: false })),
    ...Object.entries(OPTIONAL_MODEL_READER_BASELINES).map(([name, baselines]) => ({ name, baselines, optional: true })),
  ];
  for (const { name, baselines, optional } of groups) {
    if (name === 'supervideo' && skipSupervideo) continue;
    if (name !== 'supervideo' && onlySupervideo) continue;
    const destination = path.join(skillDir, name);
    let directory;
    try { directory = await fsp.lstat(destination); } catch { continue; }
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const files = [];
    try {
      if (optional && name === 'ai-image-to-ppt') {
        const credentials = path.join(destination, 'scripts/provider_credentials.py');
        await assertConfinedDestination(skillDir, credentials);
        const stat = await fsp.lstat(credentials);
        if (!stat.isFile() || stat.isSymbolicLink() ||
            digest(await fsp.readFile(credentials)) !== digest(await fsp.readFile(path.join(sourceDir, 'skills', name, 'scripts/provider_credentials.py')))) {
          throw new Error('vision reader requires the bundled credentials reader');
        }
      }
      for (const [relativePath, oldHash] of Object.entries(baselines)) {
        const target = path.join(destination, relativePath);
        await assertConfinedDestination(skillDir, target);
        const source = path.join(sourceDir, 'skills', name, relativePath);
        let stat;
        try { stat = await fsp.lstat(target); }
        catch (error) { if (optional && error?.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('custom reader');
        const current = await fsp.readFile(target);
        const next = await fsp.readFile(source);
        if (name === 'supervideo' && relativePath === 'runtime.lock.json' && expectedSupervideoLock && digest(next) !== expectedSupervideoLock) throw new Error('bundled lock changed during installation');
        const currentHash = digest(current);
        if (!(Array.isArray(oldHash) ? oldHash : [oldHash]).includes(currentHash) && currentHash !== digest(next)) throw new Error('custom reader');
        files.push({ target, next, currentHash, mode: stat.mode });
      }
      for (const file of files) {
        if (file.currentHash === digest(file.next)) continue;
        await assertConfinedDestination(skillDir, file.target);
        if (digest(await fsp.readFile(file.target)) !== file.currentHash) throw new Error('reader changed during refresh');
        const temporary = `${file.target}.superwagie-${randomUUID()}.tmp`;
        try {
          await fsp.writeFile(temporary, file.next, { mode: file.mode & 0o777, flag: 'wx' });
          await fsp.rename(temporary, file.target);
        } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
      }
      if (files.some((file) => file.currentHash !== digest(file.next)) && !updated.includes(name)) updated.push(name);
    } catch (error) {
      warn(`[builtin-skills] ${name}: model readers were not refreshed; preserve the installed copy and reinstall the bundled skill to use Model configuration`);
    }
  }
  return updated;
};

const exists = async (target) => {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
};

// The bundled lock determines the cache name. Validate the exact manifest and
// its files before publishing a directory that an installed lock can use.
class EngineIntegrityError extends Error {}
const engineLockSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1),
  engineManifest: z.literal('engine-manifest.json'), engineVersion: z.string(),
  engineManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const engineManifestSchema = z.object({
  schemaVersion: z.literal(1), package: z.literal('supervideo-engine'), protocolVersion: z.literal(1),
  version: z.string(), files: z.array(z.object({
    path: z.string().min(1), size: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })),
});
const validateEngine = async (root, lock) => {
  if (!engineLockSchema.safeParse(lock).success) throw new EngineIntegrityError('Invalid bundled SuperVideo lock');
  await assertConfinedDestination(root, path.join(root, lock.engineManifest));
  const manifestBytes = await fsp.readFile(path.join(root, lock.engineManifest));
  if (digest(manifestBytes) !== lock.engineManifestSha256) throw new EngineIntegrityError('SuperVideo engine manifest does not match its lock');
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { throw new EngineIntegrityError('Invalid SuperVideo engine manifest'); }
  if (!engineManifestSchema.safeParse(manifest).success || manifest.version !== lock.engineVersion) throw new EngineIntegrityError('Invalid SuperVideo engine manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    if (file.path.includes('\\') || path.posix.isAbsolute(file.path) ||
        path.posix.normalize(file.path) !== file.path || file.path.split('/').some((part) => !part || part === '..' || part === '.') ||
        seen.has(file.path)) throw new EngineIntegrityError('Invalid SuperVideo engine file record');
    seen.add(file.path);
    const target = path.join(root, ...file.path.split('/'));
    await assertConfinedDestination(root, target);
    const stat = await fsp.lstat(target);
    if (!stat.isFile()) throw new EngineIntegrityError('SuperVideo engine file is not regular');
    const bytes = await fsp.readFile(target);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new EngineIntegrityError('SuperVideo engine file failed integrity verification');
  }
  if (!seen.has('src/runtime-cli.mjs')) throw new EngineIntegrityError('SuperVideo engine entrypoint is missing');
  return manifest;
};

const installSupervideoEngine = async ({ sourceDir, cacheDir, skillDir, afterInstall }) => {
  const source = path.join(sourceDir, 'supervideo-engine');
  const lockBytes = await fsp.readFile(path.join(sourceDir, 'skills', 'supervideo', 'runtime.lock.json'));
  const lock = JSON.parse(lockBytes);
  const manifest = await validateEngine(source, lock);
  const shared = path.join(skillDir, '.supervideo-engines');
  await assertConfinedDestination(skillDir, shared);
  await fsp.mkdir(shared, { recursive: true });
  await assertConfinedDestination(skillDir, shared);
  const publish = async (root, engines) => {
    await assertConfinedDestination(root, engines);
    await fsp.mkdir(engines, { recursive: true });
    await assertConfinedDestination(root, engines);
    const engine = path.join(engines, lock.engineManifestSha256);
    await assertConfinedDestination(root, engine);
    let valid = false;
    if (await exists(engine)) {
      try { await validateEngine(engine, lock); valid = true; }
      catch (error) {
        if (!(error instanceof EngineIntegrityError) && error?.code !== 'ENOENT') throw error;
      }
    }
    if (valid) return;
    const staging = await fsp.mkdtemp(path.join(engines, '.supervideo-stage-'));
    try {
      for (const relative of [lock.engineManifest, ...manifest.files.map((file) => file.path)]) {
        const src = path.join(source, ...relative.split('/'));
        const dst = path.join(staging, ...relative.split('/'));
        await assertConfinedDestination(source, src);
        const stat = await fsp.lstat(src);
        if (!stat.isFile()) throw new Error('SuperVideo engine file is not regular');
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.writeFile(dst, await fsp.readFile(src), { mode: stat.mode & 0o777, flag: 'wx' });
      }
      await validateEngine(staging, lock);
      if (await exists(engine)) {
        // Preserve an incomplete cache rather than deleting potentially useful files.
        await fsp.rename(engine, `${engine}.incomplete-${randomUUID()}`);
      }
      await fsp.rename(staging, engine);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  };
  return withSourceControlFileLock(path.join(shared, '.install.lock'), async () => {
    await publish(skillDir, shared);
    const engines = path.join(cacheDir, 'supervideo', 'engines');
    await assertConfinedDestination(cacheDir, engines);
    await fsp.mkdir(engines, { recursive: true });
    await assertConfinedDestination(cacheDir, engines);
    await withSourceControlFileLock(path.join(engines, '.install.lock'), () => publish(cacheDir, engines));
    return afterInstall(digest(lockBytes));
  });
};

/**
 * Install and refresh exact app-managed skill copies.
 *
 * Foreign host skills and modified or unidentified copies remain untouched.
 * Receipts and exact legacy inventories authorize managed refresh checks.
 * Failures are reported and
 * skipped: one unreadable skill must not keep the app from starting.
 */
export const installBuiltinSkills = async ({
  sourceDir,
  skillDir,
  dataDir,
  cacheDir,
  existingSkillDirs = [skillDir],
  // Packaged Electron ships nested node_modules outside the asar filters here.
  extraSkillsDir = null,
  warn = () => {},
}) => {
  const installed = [];
  const skipped = [];
  const failed = [];
  const updated = [];

  const conflictsWithOtherHost = async (name) => {
    for (const dir of existingSkillDirs) {
      if (path.resolve(dir) !== path.resolve(skillDir) && await exists(path.join(dir, name))) return true;
    }
    return false;
  };

  const install = async (name, source, destination, root, kind = 'skill', before = async () => {}) => {
    try {
      if (await conflictsWithOtherHost(name)) {
        skipped.push(name);
        return;
      }
      const verifyCurrent = await before();
      const status = await refreshManagedTree({ name, kind, source, destination, root, verifyCurrent, legacy: legacyIdentities[name] || [], warn });
      ({ installed, skipped, updated })[status].push(name);
      return status;
    } catch (error) {
      (error.preserved ? skipped : failed).push(name);
      warn(`[builtin-skills] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let entries = [];
  try {
    entries = (await fsp.readdir(path.join(sourceDir, 'skills'), { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    warn(`[builtin-skills] bundled skills missing: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extraSource = extraSkillsDir ? path.join(extraSkillsDir, entry.name) : null;
    const source = extraSource && await exists(extraSource)
      ? extraSource
      : path.join(sourceDir, 'skills', entry.name);
    const destination = path.join(skillDir, entry.name);
    if (entry.name === 'supervideo') {
      if (await conflictsWithOtherHost(entry.name)) {
        skipped.push(entry.name);
        continue;
      }
      try {
        await installSupervideoEngine({ sourceDir, cacheDir, skillDir, afterInstall: async (expectedSupervideoLock) => {
          // An older bundle cannot replace a launcher whose lock it never shipped.
          const currentLock = path.join(destination, 'runtime.lock.json');
          let canRefresh = true;
          if (await exists(destination)) {
            await assertConfinedDestination(skillDir, currentLock);
            const current = await statOrNull(currentLock);
            const currentHash = current?.isFile() ? digest(await fsp.readFile(currentLock)) : null;
            canRefresh = currentHash === expectedSupervideoLock || MODEL_READER_BASELINES.supervideo['runtime.lock.json'].includes(currentHash);
          }
          if (canRefresh) {
            await install(entry.name, source, destination, skillDir, 'skill', async () => {
              if (digest(await fsp.readFile(path.join(source, 'runtime.lock.json'))) !== expectedSupervideoLock) throw new Error('SuperVideo skill lock changed during installation');
            });
          } else {
            skipped.push(entry.name);
          }
          for (const name of await refreshModelReaders({ sourceDir, skillDir, warn, onlySupervideo: true, expectedSupervideoLock })) {
            if (!updated.includes(name)) updated.push(name);
          }
        } });
      } catch (error) {
        failed.push('supervideo-engine');
        warn(`[builtin-skills] supervideo engine: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    await install(entry.name, source, destination, skillDir);
  }

  // Both plugins resolve their complete physical runtime through this link.
  for (const name of ['superppt', 'image-to-editable-pptx']) {
    const runtime = path.join(dataDir, 'skills-runtime', name);
    const link = path.join(skillDir, name);
    const target = path.join(runtime, 'skills', name);
    const candidates = [
      ...(extraSkillsDir ? [path.join(extraSkillsDir, 'presentation-runtime', name), path.join(extraSkillsDir, name)] : []),
      path.join(sourceDir, '..', 'presentation-runtime', name),
      path.join(sourceDir, name),
    ];
    let source = candidates.at(-1);
    for (const candidate of candidates) { if (await exists(candidate)) { source = candidate; break; } }
    // Older fixture/source bundles can omit the newly introduced plugin.
    if (name === 'image-to-editable-pptx' && !(await exists(source))) continue;
    let replacePlaceholder = false;
    const status = await install(name, source, runtime, dataDir, 'plugin', async () => {
      await assertPresentationTarget(source);
      await assertDestination(skillDir, skillDir);
      const stat = await statOrNull(link);
      replacePlaceholder = name === 'image-to-editable-pptx' && await isImagePlaceholder(link);
      if (stat && !replacePlaceholder && (!stat.isSymbolicLink() || path.resolve(path.dirname(link), await fsp.readlink(link)) !== path.resolve(target))) {
        throw Object.assign(new Error('foreign presentation skill path; preserved'), { preserved: true });
      }
      return !stat || replacePlaceholder;
    });
    if (status) {
      try {
        await assertDestination(dataDir, runtime);
        await exposePresentationSkill({ name, skillDir, runtime, replacePlaceholder });
        const launcher = path.join(dataDir, 'skills-runtime', `${name}.launcher.json`);
        const bytes = `${JSON.stringify(presentationCommand(await fsp.realpath(runtime)))}\n`;
        const current = await statOrNull(launcher);
        if (current && !current.isFile()) throw new Error('Launcher descriptor is not a regular file');
        if (!current || await fsp.readFile(launcher, 'utf8') !== bytes) {
          const temporary = `${launcher}.${randomUUID()}.tmp`;
          try {
            await fsp.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
            await fsp.rename(temporary, launcher);
          } finally { await fsp.rm(temporary, { force: true }); }
        }
      } catch (error) {
        failed.push(name);
        warn(`[builtin-skills] ${name} link: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  for (const name of await refreshModelReaders({ sourceDir, skillDir, warn, skipSupervideo: true })) {
    if (!updated.includes(name)) updated.push(name);
  }

  return { installed, skipped, updated, failed };
};
