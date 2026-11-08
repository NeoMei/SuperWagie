import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTransportNative } from './transport-native.js';
import { transportFileHash } from './transport-files.js';
test('private child preserves split UTF8, uses stdin/key env and sanitizes failing stdio', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-native-')); const binary = path.join(dir, 'native');
  try {
    await fs.writeFile(binary, `#!${process.execPath}\nlet input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(process.argv.length!==2||process.env.SYSTEM_AES_KEY!=='private-aes'||JSON.parse(input).targetParameters.api_key!=='private-key')process.exit(1);const b=Buffer.from(JSON.stringify({status:'preview',message:'中文'}));process.stdout.write(b.subarray(0,b.length-3));setTimeout(()=>process.stdout.end(b.subarray(b.length-3)),10);});`, { mode: 0o700 });
    const options = { binary, binarySha256: await transportFileHash(binary), configDir: dir, systemAesKey: 'private-aes', request: { targetParameters: { api_key: 'private-key' } } };
    expect((await runTransportNative(options)).message).toBe('中文');
    await fs.writeFile(binary, `#!${process.execPath}\nprocess.stderr.write('private-key');process.stdout.write('private-source');process.exit(1);`);
    await expect(runTransportNative({ ...options, binarySha256: await transportFileHash(binary) })).rejects.toThrow('transport_native_rejected');
    await expect(runTransportNative(options)).rejects.toThrow('transport_binary_changed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
