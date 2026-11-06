import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentTimeout, OFFICE_LIMITS, officeError, validateSemanticNodes } from './office-limits.mjs';
import { killDocumentProcess } from './document-process.mjs';

const worker = fileURLToPath(new URL('./office-worker.mjs', import.meta.url));

// A separate owned process gives ZIP inflation, synchronous page JS and cleanup a hard deadline.
async function runOfficeWorker(request, timeoutMs) {
  const temporary = await mkdtemp(join(tmpdir(), 'supervideo-office-'));
  let child; let browserPid; let timer; let stopTimer;
  try {
    return await new Promise((resolve, reject) => {
      let reply; let failure; let output = 0; let done = false;
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer); clearTimeout(stopTimer);
        if (failure) reject(failure);
        else if (reply?.error) reject(officeError(reply.error.code, reply.error.message));
        else if (reply?.result) resolve(reply.result);
        else reject(officeError('DOCUMENT_PROCESS_FAILED', 'Office worker exited without a result'));
      };
      const stop = error => {
        failure ??= error; killDocumentProcess(browserPid);
        // Playwright registers its browser exit cleanup before launchServer resolves.
        // Let that cleanup run even while the browser PID is still unknown here.
        if (process.platform === 'win32') killDocumentProcess(child?.pid);
        else child?.kill('SIGTERM');
        stopTimer ??= setTimeout(() => { killDocumentProcess(browserPid); killDocumentProcess(child?.pid); if (child?.connected) child.disconnect(); child?.stdout.destroy(); child?.stderr.destroy(); child?.unref(); finish(); }, 2000);
      };
      child = fork(worker, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32', execArgv: [], env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary } });
      timer = setTimeout(() => stop(officeError('DOCUMENT_TIMEOUT', 'Office parsing or rendering exceeded its deadline')), timeoutMs);
      const consume = chunk => { output += chunk.length; if (output > 65536) stop(officeError('DOCUMENT_RESOURCE_LIMIT', 'Office worker diagnostics exceeded the limit')); };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.on('message', message => {
        if (message?.browserPid && Number.isSafeInteger(message.browserPid)) { browserPid = message.browserPid; if (failure) killDocumentProcess(browserPid); }
        else if (message?.browserClosed) browserPid = undefined;
        else if (message?.result || message?.error) reply = message;
      });
      child.on('error', () => stop(officeError('DOCUMENT_PROCESS_FAILED', 'Office worker could not start')));
      child.on('close', finish);
      child.send(request, error => { if (error) stop(officeError('DOCUMENT_PROCESS_FAILED', 'Office worker request failed')); });
    });
  } finally {
    clearTimeout(timer); clearTimeout(stopTimer);
    killDocumentProcess(browserPid);
    await rm(temporary, { recursive: true, force: true });
  }
}
export function inspectOfficeDocument(inputPath, kind, config) {
  return runOfficeWorker({ operation: 'inspect', inputPath, kind, config: { playwrightModule: config.playwrightModule } }, Math.min(documentTimeout(config), OFFICE_LIMITS.inspectTimeoutMs));
}
export function renderOfficePages(inputPath, kind, outputDir, config, fallbackNodes = [], packageInfo) {
  if (!config.browserExecutable || !config.playwrightModule) throw officeError('DEPENDENCY_MISSING', 'Configure Chrome and Playwright for Office page rendering');
  validateSemanticNodes(fallbackNodes);
  return runOfficeWorker({ operation: 'render', inputPath, kind, outputDir, config: { browserExecutable: config.browserExecutable, playwrightModule: config.playwrightModule }, fallbackNodes, packageInfo }, documentTimeout(config));
}

export function probeOfficeBrowser(config) {
  return runOfficeWorker({ operation: 'probe', config: { browserExecutable: config.browserExecutable, playwrightModule: config.playwrightModule } }, 20000);
}
