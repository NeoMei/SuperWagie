import fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** The engine build pinned by the bundled supervideo skill's runtime.lock.json. */
const SUPERVIDEO_ENGINE = '1e0433d6e916bfcfacad226151f809b19a6400625400aff2ef0bf3f2e6a0be91';


const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Only these byte-identical shipped readers may be refreshed. Other skill
// content, modified readers and skills in another host's directory stay owned
// by the user. Updating a helper first preserves the old adapters during a
// partially completed refresh, and every adapter refresh is retryable.
const MODEL_READER_BASELINES = {
  'ai-image-to-ppt': {
    "scripts/provider_credentials.py": ["aa7652a595e5bdf4da546ef4e3455781598f3541126cefa824a82c03b2d8c223", "779c7b687a5c54b9d908828a1a7c97d5fc2d37284646f10f0f475af9e3e549fd"],
    "scripts/gen_slide.py": "35ff14e87e0b48004604526240006cd7696a21abb8dee08710502fe3e8e04eda",
    "scripts/gen_slide_openai.py": "76218e38840b87844101408df244b8004a9fdfbdf81336fca0b8363bb833039d",
    "scripts/gen_slide_gemini.py": "91107d27faae0863be3aaeda44e2c1f437f2f891c61d56c3089882e432d3c9b0",
    "scripts/gen_slide_doubao.py": "a2effcc99abcec44f34d2d0853b8d81197f9487a74240b2398f5e8c5370e88f3"
},
  supervideo: { 'runtime.lock.json': ['2a69e8230265b5931baa0b0b7c309f5384bd444063484eeb0f9742f1a7b52b0c', '360426fbac3400a61b6df1a0167bf60d8ccacfdb55ca07d741459b392972eb8e', 'e5d8842a4f1bd4881210636480dc7d3eabdddefad0e4e46061c31c42736144ac', '28164ef0767741f22d09edb6a3a486728e21fe55bf6d4f02fadac5f32247da02', '8c37b9da179641881bc544b9e1dfbfd99bb1f6d5210529395a2e0b65ef6c173d'] },
  'managed-image-edit': {
    'scripts/edit.mjs': ['776b0206804687c8a5e24abc7446617bb0aeb6649906e9d35546aaa8d67e8eb5', '188752c9dcfe56166e42b9499bc21aa5c95342718b73c6fcf3fbb9ea398c72f6'],
    'SKILL.md': 'df281ab3fdd2ee4f21e3dc84f9ac214591f0ced5d863fba772a6c32cb980a994',
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

const refreshModelReaders = async ({ sourceDir, skillDir, warn }) => {
  const updated = [];
  for (const [name, baselines] of Object.entries(MODEL_READER_BASELINES)) {
    const destination = path.join(skillDir, name);
    let directory;
    try { directory = await fsp.lstat(destination); } catch { continue; }
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const files = [];
    try {
      for (const [relativePath, oldHash] of Object.entries(baselines)) {
        const target = path.join(destination, relativePath);
        await assertConfinedDestination(skillDir, target);
        const source = path.join(sourceDir, 'skills', name, relativePath);
        const stat = await fsp.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('custom reader');
        const current = await fsp.readFile(target);
        const next = await fsp.readFile(source);
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
      if (files.some((file) => file.currentHash !== digest(file.next))) updated.push(name);
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

// The bundle lives inside app.asar in packaged builds, where `fs.cp` cannot
// read it. Walking with readdir/readFile (both asar-aware) also keeps the
// executable bit on the bundled scripts.
const copyTree = async (from, to) => {
  const stat = await fsp.stat(from);
  if (stat.isDirectory()) {
    await fsp.mkdir(to, { recursive: true });
    for (const entry of await fsp.readdir(from)) {
      await copyTree(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, await fsp.readFile(from));
  await fsp.chmod(to, stat.mode & 0o777).catch(() => {});
};

/**
 * First-run install of the skills SuperWagie ships with.
 *
 * A skill already present in any OpenCode skill directory is left alone, so an
 * install this app made once, a hand copy, or the same skill from another host
 * never gets a second copy or an overwritten edit. Failures are reported and
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

  const alreadyPresent = async (name) => {
    for (const dir of existingSkillDirs) {
      if (await exists(path.join(dir, name))) return true;
    }
    return false;
  };

  const install = async (name, run) => {
    if (await alreadyPresent(name)) {
      skipped.push(name);
      return;
    }
    try {
      await run();
      installed.push(name);
    } catch (error) {
      failed.push(name);
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
    await install(entry.name, async () => {
      await assertConfinedDestination(skillDir, destination);
      await copyTree(source, destination);
      // electron-builder treats a top-level node_modules in an extra resource as
      // packaging metadata. The payload carries dependencies under vendor/.
      const vendoredModules = path.join(destination, 'vendor', 'node_modules');
      if (await exists(vendoredModules)) {
        await copyTree(vendoredModules, path.join(destination, 'node_modules'));
        await fsp.rm(path.join(destination, 'vendor'), { recursive: true, force: true });
      }
    });
  }

  // SuperPPT reads its plugin root as two levels above its own folder, so the
  // skill is linked from a runtime root instead of copied into the skills dir.
  await install('superppt', async () => {
    const runtime = path.join(dataDir, 'skills-runtime', 'superppt');
    await assertConfinedDestination(dataDir, runtime);
    if (!(await exists(runtime))) {
      await copyTree(path.join(sourceDir, 'superppt'), runtime);
    }
    const link = path.join(skillDir, 'superppt');
    await assertConfinedDestination(skillDir, link);
    if (await exists(link)) return;
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.symlink(path.join(runtime, 'skills', 'superppt'), link, process.platform === 'win32' ? 'junction' : 'dir');
  });

  const updated = await refreshModelReaders({ sourceDir, skillDir, warn });

  // SuperVideo looks for its engine in the shared cache next to the skill.
  if (await exists(path.join(skillDir, 'supervideo'))) {
    try {
      const engine = path.join(cacheDir, 'supervideo', 'engines', SUPERVIDEO_ENGINE);
      await assertConfinedDestination(cacheDir, engine);
      if (!(await exists(engine))) {
        await copyTree(path.join(sourceDir, 'supervideo-engine'), engine);
      }
    } catch (error) {
      failed.push('supervideo-engine');
      warn(`[builtin-skills] supervideo engine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { installed, skipped, updated, failed };
};
