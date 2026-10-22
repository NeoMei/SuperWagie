import assert from 'node:assert/strict';
import test from 'node:test';

test('Windows uses Git Bash even when the WSL launcher precedes Git on PATH', async () => {
  const { resolveGitBashExecutable } = await import('./git-bash-executable.mjs');
  const files = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe']);
  assert.equal(resolveGitBashExecutable({
    platform: 'win32', env: { Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd' },
    fileExists: (file) => files.has(file),
  }), 'C:\\Program Files\\Git\\bin\\bash.exe');
});

test('missing Git Bash fails explicitly instead of invoking WSL', async () => {
  const { resolveGitBashExecutable } = await import('./git-bash-executable.mjs');
  assert.throws(() => resolveGitBashExecutable({ platform: 'win32', env: {}, fileExists: () => false }), /Git Bash/);
});

test('POSIX retains its bash executable lookup', async () => {
  const { resolveGitBashExecutable } = await import('./git-bash-executable.mjs');
  assert.equal(resolveGitBashExecutable({ platform: 'darwin' }), 'bash');
});
