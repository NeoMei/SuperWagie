import { spawn } from 'node:child_process';
import { OFFICE_LIMITS, officeError } from './office-limits.mjs';

// This boundary is scoped to document tools. Other engine process callers keep their contracts.
export function killDocumentProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('error', () => {});
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}
export function runDocumentProcess(file, args, { input, timeoutMs = 5000, env = process.env } = {}) {
  return new Promise(resolve => {
    let stdout = ''; let stderr = ''; let length = 0; let timedOut = false; let outputLimited = false; let settled = false; let forceTimer;
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(forceTimer); resolve({ code, stdout, stderr, timedOut, outputLimited }); };
    const stop = () => { killDocumentProcess(child.pid); forceTimer ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null); }, 2000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = (stream, chunk) => {
      length += Buffer.byteLength(chunk);
      if (length > OFFICE_LIMITS.processOutput) { outputLimited = true; stop(); return; }
      if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => { stderr = error.message.slice(0, 2048); finish(null); });
    child.on('close', finish);
    child.stdin.end(input);
  });
}
export async function probeMarkitdown(command = 'markitdown') {
  const result = await runDocumentProcess(command, ['--version']);
  const version = result.stdout.trim().match(/^markitdown\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/i)?.[1];
  return { available: result.code === 0 && !result.timedOut && !result.outputLimited && Boolean(version), version: version ?? null };
}
export function assertDocumentProcess(result) {
  if (result.outputLimited) throw officeError('DOCUMENT_RESOURCE_LIMIT', 'Document tool output exceeds 16 MiB');
  if (result.code !== 0 || result.timedOut) throw officeError('DOCUMENT_PROCESS_FAILED', result.timedOut ? 'Document process timed out' : (result.stderr || result.stdout || 'Document process failed').slice(0, 2048));
}
