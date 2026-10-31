import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const RECEIPT = '.superwagie-managed.json';
export const BUNDLE = '.superwagie-bundle.json';
const owner = 'superwagie-builtin-skills';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identity = (value) => hash(JSON.stringify(value));
const validPath = (value) => value.length > 0
  && !value.includes('\\') && !value.includes(':') && !value.includes('\0')
  && value.split('/').every((part) => part && part !== '.' && part !== '..');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const preserved = (message) => Object.assign(new Error(message), { preserved: true });
const relativePath = z.string().refine(validPath);
const digestValue = z.string().regex(/^[a-f0-9]{64}$/);
const componentVersion = z.string().regex(/^\d+\.\d+\.\d+$/).nullable().optional();
const opaquePath = relativePath.refine((value) => value === 'node_modules' || value.split('/').at(-1) === '__pycache__');
const inventoryEntry = z.union([
  z.tuple([relativePath, z.literal('directory')]),
  z.tuple([relativePath, z.literal('file'), digestValue, z.number().int().min(0).max(0o111)]),
  z.tuple([relativePath, z.literal('link'), z.string()]),
]);
const bundleSchema = z.object({ schema: z.literal(1), id: digestValue, closure: z.string().nullable(), version: componentVersion });
const receiptSchema = z.object({
  schema: z.literal(1), owner: z.literal(owner), name: z.string(), kind: z.string(),
  bundle: digestValue, version: componentVersion, closure: z.string().nullable(),
  entries: z.array(inventoryEntry), digest: digestValue, opaque: z.array(opaquePath),
});
const recoverySchema = z.object({
  schema: z.literal(1), id: z.string().uuid(), opaque: z.array(opaquePath),
  nextDigest: digestValue, oldDigest: digestValue.nullable(),
  nextReceipt: digestValue, oldReceipt: digestValue.nullable(),
});


export async function statOrNull(target, io = fs) {
  try { return await io.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function assertDestination(root, target, io = fs) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw preserved('destination escapes managed root');
  let current = path.resolve(root);
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await statOrNull(current, io);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw preserved('destination contains a link or non-directory');
  }
}

// Reads and writes remain asar-aware. The only accepted payload links are
// relative dependency links whose resolved targets stay inside the source.
export async function copyPayload(source, destination, { io = fs, opaque = [], normalized = true, encodedModules = false, relative = '' } = {}) {
  const stat = await io.lstat(source);
  if (relative.split('/').at(-1) === 'node_modules' && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw preserved('dependency root must be a physical directory');
  }
  if (stat.isSymbolicLink()) {
    if (!relative.split('/').includes('node_modules')) throw preserved('payload contains a symbolic link');
    const target = await io.readlink(source);
    const resolved = await io.realpath(source);
    const segments = relative.split('/');
    const moduleIndex = segments.indexOf('node_modules');
    const dependencyRoot = path.resolve(source, ...Array(segments.length - moduleIndex - 1).fill('..'));
    const confined = path.relative(await io.realpath(dependencyRoot), resolved);
    if (path.isAbsolute(target) || confined === '..' || confined.startsWith(`..${path.sep}`)) throw preserved('dependency link escapes bundle');
    await io.symlink(target, destination);
  } else if (stat.isDirectory()) {
    await io.mkdir(destination, { recursive: true });
    const names = (await io.readdir(source)).sort();
    if (!relative && normalized && names.includes('vendor')) {
      const vendor = path.join(source, 'vendor');
      const vendorStat = await io.lstat(vendor);
      const vendorNames = await io.readdir(vendor);
      if (vendorStat.isSymbolicLink() || !vendorStat.isDirectory() || !['node_modules', 'modules'].some((name) => same(vendorNames, [name])) || names.includes('node_modules')) {
        throw preserved('unexpected packaged vendor layout');
      }
    }
    for (const name of names) {
      if (!relative && [RECEIPT, BUNDLE].includes(name)) continue;
      const outputName = encodedModules && relative.split('/').includes('node_modules') && name === '__superwagie_node_modules__' ? 'node_modules' : name;
      if (outputName !== name && names.includes(outputName)) throw preserved('competing dependency transport directories');
      const child = relative ? `${relative}/${outputName}` : outputName;
      if (opaque.includes(child)) continue;
      if (!relative && normalized && name === 'vendor') {
        if (!opaque.includes('node_modules')) {
          const layout = (await io.readdir(path.join(source, name)))[0];
          await copyPayload(path.join(source, name, layout), path.join(destination, 'node_modules'), { io, opaque, relative: 'node_modules', normalized, encodedModules: layout === 'modules' });
        }
      } else {
        await copyPayload(path.join(source, name), path.join(destination, outputName), { io, opaque, relative: child, normalized, encodedModules });
      }
    }
  } else if (stat.isFile()) {
    await io.writeFile(destination, await io.readFile(source), { flag: 'wx', mode: stat.mode & 0o777 });
    await io.chmod(destination, stat.mode & 0o777);
  } else throw preserved('unsupported payload entry');
}

export async function inventory(root, { io = fs, opaque = [], allowCache = false, ignoreBundle = false, sourceOnly = false } = {}) {
  const entries = [];
  const caches = [];
  async function walk(directory, relative = '') {
    const names = (await io.readdir(directory)).sort();
    const folded = new Set();
    for (const name of names) {
      if (sourceOnly && (name === '__pycache__' || (!relative && ['node_modules', 'vendor', 'dist'].includes(name)))) continue;
      if (!relative && (name === RECEIPT || (ignoreBundle && name === BUNDLE))) continue;
      const child = relative ? `${relative}/${name}` : name;
      if (!validPath(child) || folded.has(name.toLowerCase())) throw preserved('unsupported payload path');
      folded.add(name.toLowerCase());
      const stat = await io.lstat(path.join(directory, name));
      if (opaque.includes(child) || (allowCache && name === '__pycache__')) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw preserved('generated directory is linked');
        caches.push(child);
        continue;
      }
      if (stat.isDirectory()) {
        entries.push([child, 'directory']);
        await walk(path.join(directory, name), child);
      } else if (stat.isFile()) {
        entries.push([child, 'file', hash(await io.readFile(path.join(directory, name))), process.platform === 'win32' ? 0 : stat.mode & 0o111]);
      } else if (stat.isSymbolicLink() && child.split('/').includes('node_modules')) {
        entries.push([child, 'link', await io.readlink(path.join(directory, name))]);
      } else throw preserved('installed payload contains a link or unsupported entry');
    }
  }
  const stat = await io.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw preserved('installed root is linked');
  await walk(root);
  return { entries, opaque: caches.sort() };
}

async function dependencyClosure(root, io) {
  try {
    const lock = JSON.parse(await io.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    delete lock.version;
    if (lock.packages?.['']) delete lock.packages[''].version;
    return identity(lock);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Build-time producer. Runtime startup only reads this identity. */
export async function writeBundleIdentity(root, { sourceOnly = false, check = false } = {}) {
  const entries = (await inventory(root, { ignoreBundle: true, sourceOnly })).entries;
  const closure = await dependencyClosure(root, fs);
  let version = null;
  for (const filename of ['VENDOR-SNAPSHOT.json', 'package.json']) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(root, filename), 'utf8'));
      if (/^\d+\.\d+\.\d+$/.test(value.version)) { version = value.version; break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const bytes = `${JSON.stringify({ schema: 1, id: identity({ entries, closure }), closure, version })}\n`;
  if (check) {
    if (await fs.readFile(path.join(root, BUNDLE), 'utf8') !== bytes) throw new Error('Bundled skill identity is stale');
  } else await fs.writeFile(path.join(root, BUNDLE), bytes);
}

export async function bundleIdentity(source, io = fs) {
  const manifest = await statOrNull(path.join(source, BUNDLE), io);
  if (manifest) {
    if (!manifest.isFile()) throw preserved('invalid bundle identity');
    try { return bundleSchema.parse(JSON.parse(await io.readFile(path.join(source, BUNDLE), 'utf8'))); }
    catch { throw preserved('invalid bundle identity'); }
  }
  // Development and small external fixtures can lack release metadata.
  const tree = await inventory(source, { io, ignoreBundle: true });
  return { schema: 1, id: identity(tree.entries), closure: await dependencyClosure(source, io) };
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) { if (a[index] !== b[index]) return a[index] - b[index]; }
  return 0;
}

async function readReceipt(destination, name, kind, io) {
  const filename = path.join(destination, RECEIPT);
  const stat = await statOrNull(filename, io);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw preserved('invalid managed receipt');
  let receipt;
  try { receipt = receiptSchema.parse(JSON.parse(await io.readFile(filename, 'utf8'))); } catch { throw preserved('invalid managed receipt'); }
  if (receipt.name !== name || receipt.kind !== kind || receipt.digest !== identity(receipt.entries)) throw preserved('invalid managed receipt');
  return receipt;
}

async function acquireGuard(destination, io) {
  const filename = `${destination}.superwagie-guard.sqlite`;
  try { const handle = await io.open(filename, 'wx', 0o600); await handle.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await io.lstat(filename);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw preserved('unsafe installer guard');
  let database;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(filename, { timeout: 0 });
    database.exec('PRAGMA busy_timeout=0');
    if (database.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw preserved('unsafe installer guard mode');
    database.exec('BEGIN EXCLUSIVE');
    return () => { try { database.exec('ROLLBACK'); } finally { database.close(); } };
  } catch (error) {
    try { database?.close(); } catch { /* The connection has no payload writes. */ }
    if ([5, 6].includes(error.errcode) || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)) throw preserved('refresh busy; retry on next startup');
    throw error;
  }
}

async function writeJson(filename, value, io) {
  const handle = await io.open(filename, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

function transactionPaths(destination, id) {
  return { stage: `${destination}.superwagie-${id}.stage`, backup: `${destination}.superwagie-${id}.backup`, journal: `${destination}.superwagie-transaction.json` };
}

async function moveOpaque(from, to, paths, io) {
  for (const relative of paths) {
    const source = path.join(from, relative);
    if (!(await statOrNull(source, io))) continue;
    await assertDestination(from, source, io);
    await assertDestination(to, path.dirname(path.join(to, relative)), io);
    if (await statOrNull(path.join(to, relative), io)) throw preserved('generated directory collision during recovery');
    await io.mkdir(path.dirname(path.join(to, relative)), { recursive: true });
    await io.rename(source, path.join(to, relative));
  }
}

async function receiptDigest(directory, io) {
  const filename = path.join(directory, RECEIPT);
  const stat = await statOrNull(filename, io);
  if (!stat) return null;
  if (!stat.isFile()) throw preserved('recovery receipt is linked');
  return hash(await io.readFile(filename));
}

async function recover(destination, io) {
  const journal = `${destination}.superwagie-transaction.json`;
  const stat = await statOrNull(journal, io);
  if (!stat) return;
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw preserved('unsafe recovery record');
  let record;
  try { record = recoverySchema.parse(JSON.parse(await io.readFile(journal, 'utf8'))); } catch { throw preserved('invalid recovery record'); }
  const { stage, backup } = transactionPaths(destination, record.id);
  for (const candidate of [destination, stage, backup]) await assertDestination(path.dirname(destination), candidate, io);
  let live = await statOrNull(destination, io);
  const old = await statOrNull(backup, io);
  if (!live && old) {
    if (await statOrNull(stage, io)) await moveOpaque(stage, backup, record.opaque, io);
    if (identity((await inventory(backup, { io, opaque: record.opaque })).entries) !== record.oldDigest || await receiptDigest(backup, io) !== record.oldReceipt) throw preserved('recovery backup was edited; retained');
    await io.rename(backup, destination);
    live = await statOrNull(destination, io);
  }
  if (live) {
    const digest = identity((await inventory(destination, { io, opaque: record.opaque })).entries);
    const metadata = await receiptDigest(destination, io);
    if (!((digest === record.oldDigest && metadata === record.oldReceipt) || (digest === record.nextDigest && metadata === record.nextReceipt))) throw preserved('recovery live copy was edited; retained');
  } else if (record.oldDigest !== null) throw preserved('recovery has no valid installed copy');
  // Opaque data may receive writes through an already-open handle after rename.
  // Keep the old core backup when it no longer matches, and report its retention.
  if (await statOrNull(backup, io)) {
    for (const relative of record.opaque) {
      if (await statOrNull(path.join(backup, relative), io)) throw preserved('generated data remains in backup; retained');
    }
    if (identity((await inventory(backup, { io, opaque: record.opaque })).entries) !== record.oldDigest || await receiptDigest(backup, io) !== record.oldReceipt) throw preserved('recovery backup was edited; retained');
    await io.rm(backup, { recursive: true });
  }
  if (await statOrNull(stage, io)) {
    if (identity((await inventory(stage, { io, opaque: record.opaque })).entries) !== record.nextDigest || await receiptDigest(stage, io) !== record.nextReceipt) throw preserved('recovery stage was edited; retained');
    await io.rm(stage, { recursive: true });
  }
  await io.unlink(journal);
}

/** A receipt authorizes a check. Only the matching complete tree authorizes replacement. */
export async function refreshManagedTree({ name, kind = 'skill', source, destination, root, legacy = [], verifyCurrent = false, io = fs, warn = () => {} }) {
  await assertDestination(root, destination, io);
  const next = await bundleIdentity(source, io);
  if (!verifyCurrent && !(await statOrNull(`${destination}.superwagie-transaction.json`, io)) && await statOrNull(destination, io)) {
    const current = await readReceipt(destination, name, kind, io);
    if (current?.bundle === next.id) return 'skipped';
  }
  await io.mkdir(path.dirname(destination), { recursive: true });
  const release = await acquireGuard(destination, io);
  let paths;
  let journalWritten = false;
  try {
    await assertDestination(root, destination, io);
    await recover(destination, io);
    const present = await statOrNull(destination, io);
    const receipt = present ? await readReceipt(destination, name, kind, io) : null;
    if (receipt?.bundle === next.id && !verifyCurrent) return 'skipped';
    if (receipt?.version && (!next.version || compareVersions(receipt.version, next.version) > 0)) throw preserved('newer managed installation; preserved');
    let previous;
    let opaque = [];
    if (present) {
      const hasModules = await statOrNull(path.join(destination, 'node_modules'), io);
      const trackedModules = receipt?.entries.some((entry) => entry[0] === 'node_modules');
      if (hasModules && !trackedModules) {
        if ((receipt && !receipt.opaque.includes('node_modules')) || (!receipt && !['superweb', 'superppt'].includes(name))) throw preserved('untracked dependency directory; preserved');
        opaque.push('node_modules');
      }
      previous = await inventory(destination, { io, opaque, allowCache: name === 'WPSComposer' });
      opaque = previous.opaque;
      if (receipt) {
        const comparable = receipt.entries.filter((entry) => !opaque.some((p) => entry[0] === p || entry[0].startsWith(`${p}/`)));
        if (!same(previous.entries, comparable)) throw preserved('installed files were edited; preserved');
      } else {
        const match = legacy.find((profile) => same(previous.entries, profile.entries.map((entry) => process.platform === 'win32' && entry[1] === 'file' ? [...entry.slice(0, 3), 0] : entry)));
        if (!match) throw preserved('installed copy has no matching managed identity; preserved');
        if (opaque.includes('node_modules') && match.closure !== next.closure) throw preserved('untracked dependencies changed between releases; preserved');
      }
      if (receipt && opaque.includes('node_modules') && receipt.closure !== next.closure) throw preserved('untracked dependencies changed between releases; preserved');
    }
    if (receipt?.bundle === next.id) return 'skipped';
    const id = randomUUID();
    paths = transactionPaths(destination, id);
    await copyPayload(source, paths.stage, { io, opaque });
    // Retained caches can outlive shipped scripts. Their parent directories
    // belong in the staged identity before moving the cache by inode.
    for (const relative of opaque) {
      const parent = path.dirname(path.join(paths.stage, relative));
      await assertDestination(paths.stage, parent, io);
      await io.mkdir(parent, { recursive: true });
    }
    const staged = await inventory(paths.stage, { io });
    const nextReceipt = { schema: 1, owner, name, kind, bundle: next.id, version: next.version || null, closure: next.closure, entries: staged.entries, digest: identity(staged.entries), opaque };
    await writeJson(path.join(paths.stage, RECEIPT), nextReceipt, io);
    await assertDestination(root, destination, io);
    if (present) {
      const final = await inventory(destination, { io, opaque, allowCache: name === 'WPSComposer' });
      if (!same(final, previous)) throw preserved('installed files changed during refresh; preserved');
      if (!same(await readReceipt(destination, name, kind, io), receipt)) throw preserved('managed receipt changed during refresh');
    } else if (await statOrNull(destination, io)) throw preserved('destination appeared during refresh');
    await writeJson(paths.journal, { schema: 1, id, opaque, oldDigest: previous ? identity(previous.entries) : null, nextDigest: identity(staged.entries), oldReceipt: present ? await receiptDigest(destination, io) : null, nextReceipt: await receiptDigest(paths.stage, io) }, io);
    journalWritten = true;
    if (present) await io.rename(destination, paths.backup);
    await moveOpaque(paths.backup, paths.stage, opaque, io);
    await io.rename(paths.stage, destination);
    // The new payload is valid even when cleanup must be retried next startup.
    try { await recover(destination, io); }
    catch { warn('skill refreshed; recovery data retained for the next startup'); }
    return present ? 'updated' : 'installed';
  } catch (error) {
    if (journalWritten) {
      try { await recover(destination, io); }
      catch { warn('skill refresh recovery incomplete; backup and journal retained'); }
    } else if (paths) await io.rm(paths.stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally { release(); }
}
