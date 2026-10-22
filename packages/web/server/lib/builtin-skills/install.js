import fsp from 'node:fs/promises';
import path from 'node:path';

/** The engine build pinned by the bundled supervideo skill's runtime.lock.json. */
const SUPERVIDEO_ENGINE = 'c9c0d0fdd953c29cd540f56fe8f79cb1d959054714d3189cf8a9846b78e98748';

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
    if (!(await exists(runtime))) {
      await copyTree(path.join(sourceDir, 'superppt'), runtime);
    }
    const link = path.join(skillDir, 'superppt');
    if (await exists(link)) return;
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.symlink(path.join(runtime, 'skills', 'superppt'), link, process.platform === 'win32' ? 'junction' : 'dir');
  });

  // SuperVideo looks for its engine in the shared cache next to the skill.
  if (await exists(path.join(skillDir, 'supervideo'))) {
    try {
      const engine = path.join(cacheDir, 'supervideo', 'engines', SUPERVIDEO_ENGINE);
      if (!(await exists(engine))) {
        await copyTree(path.join(sourceDir, 'supervideo-engine'), engine);
      }
    } catch (error) {
      failed.push('supervideo-engine');
      warn(`[builtin-skills] supervideo engine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { installed, skipped, failed };
};
