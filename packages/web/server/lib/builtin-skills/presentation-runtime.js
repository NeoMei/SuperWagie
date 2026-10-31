import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { inventory, statOrNull, assertDestination } from './managed-tree.js';
import placeholder from './image-placeholder.json' with { type: 'json' };

const targetSchema = z.object({ schema: z.literal(1), platform: z.enum(['darwin', 'linux', 'win32']), arch: z.enum(['arm64', 'x64']), libc: z.enum(['glibc', 'musl']).nullable().optional() });

export async function assertPresentationTarget(source) {
  const filename = path.join(source, 'superwagie-runtime.json');
  const manifest = await statOrNull(filename);
  if (!manifest) {
    if (await statOrNull(path.join(source, 'VENDOR-SNAPSHOT.json'))) throw new Error('Presentation runtime is not prepared; rebuild the application package');
    return; // Preserve the existing unversioned development-payload contract.
  }
  if (!manifest.isFile()) throw new Error('Invalid presentation runtime manifest');
  const target = targetSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
  if (target.platform !== process.platform || target.arch !== process.arch || (process.platform === 'linux' && target.libc !== (process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'))) throw new Error(`Presentation runtime requires ${target.platform}-${target.arch}; this server is ${process.platform}-${process.arch}`);
}

export async function isImagePlaceholder(directory, io = fs) {
  const stat = await statOrNull(directory, io);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  // This migration accepts only the exact old 2-file payload, with no receipt.
  if (await statOrNull(path.join(directory, '.superwagie-managed.json'), io)) return false;
  const expected = placeholder.map((entry) => process.platform === 'win32' && entry[1] === 'file' ? [...entry.slice(0, 3), 0] : entry);
  return JSON.stringify((await inventory(directory, { io })).entries) === JSON.stringify(expected);
}

export async function exposePresentationSkill({ name, skillDir, runtime, replacePlaceholder = false, io = fs }) {
  const link = path.join(skillDir, name);
  const target = path.join(runtime, 'skills', name);
  const backup = `${link}.superwagie-placeholder`;
  await assertDestination(skillDir, skillDir, io);
  await io.mkdir(skillDir, { recursive: true });
  if (await statOrNull(backup, io)) {
    if (name !== 'image-to-editable-pptx' || !(await isImagePlaceholder(backup, io))) throw new Error('Edited placeholder recovery copy retained');
    const current = await statOrNull(link, io);
    if (!current) { await io.rename(backup, link); replacePlaceholder = true; }
    else if (current.isSymbolicLink() && path.resolve(path.dirname(link), await io.readlink(link)) === path.resolve(target)) await io.rm(backup, { recursive: true });
    else throw new Error('Placeholder recovery conflicts with current skill; preserved');
  }
  const stat = await statOrNull(link, io);
  if (stat?.isSymbolicLink() && path.resolve(path.dirname(link), await io.readlink(link)) === path.resolve(target)) return;
  if (stat && (!replacePlaceholder || !(await isImagePlaceholder(link, io)))) throw new Error('Foreign presentation skill preserved');
  if (stat) await io.rename(link, backup);
  try { await io.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (stat) await io.rename(backup, link); throw error; }
  if (stat) await io.rm(backup, { recursive: true });
}

export function presentationCommand(runtime) {
  return { executable: process.execPath, args: [path.join(runtime, 'dist/src/cli.js')], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}, windowsHide: true };
}
