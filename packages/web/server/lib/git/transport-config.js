import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 256 * 1024;
const TRANSPORT_CONFIG_PATTERN = [
  '^(',
  'credential(\\..*)?\\.(helper|usehttppath|username)',
  '|core\\.(sshcommand|askpass)',
  '|url\\..*\\.(insteadof|pushinsteadof)',
  '|http(\\..*)?\\..+',
  '|remote\\..*\\.proxy',
  '|remote\\..*\\.lfsurl',
  '|lfs\\.(url|standalonetransferagent)',
  '|lfs\\.customtransfer\\..*',
  '|filter\\.lfs\\.(clean|smudge|process|required)',
  '|submodule\\..*\\.(url|update)',
  ')$',
].join('');

const digest = (value) => crypto.createHash('sha256').update(value).digest('base64url');

const NUL = Buffer.from([0]);
const COMMAND = Buffer.from('command');
const COMMAND_LINE = Buffer.from('command line:');
const EXTRA_HEADER = /^http(?:\..+)?\.extraheader$/;
const TRACE_HEADER = /^(traceparent|tracestate)[ \t]*:/i;

function normalizeCommandTraceHeaders(output) {
  const entries = [];
  let start = 0;
  while (start < output.length) {
    const scopeEnd = output.indexOf(0, start);
    const originEnd = scopeEnd < 0 ? -1 : output.indexOf(0, scopeEnd + 1);
    const entryEnd = originEnd < 0 ? -1 : output.indexOf(0, originEnd + 1);
    if (entryEnd < 0) return output;
    const scope = output.subarray(start, scopeEnd);
    const origin = output.subarray(scopeEnd + 1, originEnd);
    const entry = output.subarray(originEnd + 1, entryEnd);
    let normalized = entry;
    if (scope.equals(COMMAND) && origin.equals(COMMAND_LINE)) {
      const newline = entry.indexOf(10);
      if (newline >= 0) {
        const key = entry.subarray(0, newline).toString('utf8');
        const header = TRACE_HEADER.exec(entry.subarray(newline + 1).toString('utf8'));
        if (EXTRA_HEADER.test(key) && header?.[1]) {
          normalized = Buffer.from(key + '\n' + header[1].toLowerCase() + ':');
        }
      }
    }
    entries.push(scope, NUL, origin, NUL, normalized, NUL);
    start = entryEnd + 1;
  }
  return Buffer.concat(entries);
}


export async function readEffectiveGitTransportRevision(directory, {
  gitBinary = 'git',
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
} = {}) {
  const options = {
    cwd: directory,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer,
    shell: false,
    windowsHide: true,
  };
  try {
    let configOutput;
    try {
      ({ stdout: configOutput } = await execFileImpl(gitBinary, [
      'config', '--includes', '--show-origin', '--show-scope', '--null',
      '--get-regexp', TRANSPORT_CONFIG_PATTERN,
      ], options));
    } catch (error) {
      if (error?.code === 1 && !error.killed && !error.signal) configOutput = Buffer.alloc(0);
      else throw error;
    }
    let checkoutConfigObjects;
    try {
      ({ stdout: checkoutConfigObjects } = await execFileImpl(gitBinary, [
        'ls-tree', '-z', 'HEAD', '--', '.gitmodules', '.lfsconfig', '.gitattributes',
      ], options));
    } catch (error) {
      const stderr = Buffer.from(error?.stderr ?? '').toString('utf8');
      if (error?.code === 128 && /not a valid object name HEAD|bad revision 'HEAD'/i.test(stderr)) {
        checkoutConfigObjects = Buffer.alloc(0);
      } else {
        throw error;
      }
    }
    return digest(Buffer.concat([normalizeCommandTraceHeaders(Buffer.from(configOutput)), NUL, Buffer.from(checkoutConfigObjects)]));
  } catch (error) {
    throw Object.assign(new Error('Effective Git transport configuration is unavailable'), {
      code: 'STALE_CONFIG',
      status: 409,
    });
  }
}
