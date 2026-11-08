import { spawn } from 'node:child_process';
import path from 'node:path';
import { transportFileHash } from './transport-files.js';

/** Captured private pipe; no request data enters argv, logs or temporary files. */
export async function runTransportNative({ binary, binarySha256, configDir, systemAesKey, request }) {
  if (!path.isAbsolute(binary) || await transportFileHash(binary) !== binarySha256) throw new Error('transport_binary_changed');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let stderr = false; let failed = false;
    const child = spawn(binary, [], { cwd: configDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SYSTEM_AES_KEY: systemAesKey, LANG: 'C.UTF-8' } });
    const rejectPrivate = () => { failed = true; child.kill('SIGKILL'); reject(new Error('transport_native_rejected')); };
    const timer = setTimeout(rejectPrivate, 240_000);
    child.on('error', rejectPrivate); child.stdin.on('error', rejectPrivate);
    child.stdout.on('data', (bytes) => { size += bytes.length; if (size > 64 * 1024 * 1024) rejectPrivate(); else chunks.push(bytes); });
    child.stderr.on('data', () => { stderr = true; });
    child.on('close', (code) => {
      clearTimeout(timer); if (failed) return;
      if (code !== 0 || stderr) return rejectPrivate();
      try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result.status) return rejectPrivate(); resolve(result); }
      catch { rejectPrivate(); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
