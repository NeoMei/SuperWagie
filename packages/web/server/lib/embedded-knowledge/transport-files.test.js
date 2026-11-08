import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRawFile, atomicTransportWrite, withTransportLock, assertTransportQuiescent } from './transport-files.js';

test('raw CAS retains modes, absence and opaque bytes; rejects drift and concurrent writer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-files-')); const file = path.join(dir, 'config');
  try {
    const absent = await readRawFile(file); expect(absent.exists).toBe(false);
    await atomicTransportWrite(file, Buffer.from('original\n'), 0o640, absent);
    const before = await readRawFile(file); expect(before.mode).toBe(0o640);
    await atomicTransportWrite(file, Buffer.from('next\n'), 0o640, before);
    await expect(atomicTransportWrite(file, Buffer.from('stale'), 0o600, before)).rejects.toThrow('transport_file_conflict');
    expect(await fs.readFile(file, 'utf8')).toBe('next\n');
    await withTransportLock(`${file}.lock`, async () => { await expect(withTransportLock(`${file}.lock`, async () => {})).rejects.toThrow(); });
    await fs.writeFile(`${file}.lock`, '999999999:dead');
    await withTransportLock(`${file}.lock`, async () => {});
    await fs.writeFile(`${file}-wal`, 'pending');
    await expect(assertTransportQuiescent({ database: file, stoppedPids: [] })).rejects.toThrow();
    await fs.unlink(`${file}-wal`);
    await expect(assertTransportQuiescent({ database: file, stoppedPids: [process.pid] })).rejects.toThrow();
    const handle = await fs.open(file, 'r+');
    try { await expect(assertTransportQuiescent({ database: file, stoppedPids: [] })).rejects.toThrow(); }
    finally { await handle.close(); }
    expect((await assertTransportQuiescent({ database: file, stoppedPids: [] })).stopped).toBe(true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
