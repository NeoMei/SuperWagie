import { existsSync } from 'node:fs';
import path from 'node:path';

/** The system32 bash launcher enters WSL; native builds need Git's Windows shell. */
export function resolveGitBashExecutable({ platform = process.platform, env = process.env, fileExists = existsSync } = {}) {
  if (platform !== 'win32') return 'bash';
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of pathValue.split(';').filter(Boolean)) {
    if (!fileExists(path.win32.join(directory, 'git.exe'))) continue;
    for (const relative of ['../bin/bash.exe', 'bash.exe', '../../bin/bash.exe']) {
      const candidate = path.win32.resolve(directory, relative);
      if (fileExists(candidate)) return candidate;
    }
  }
  throw new Error('Git Bash is required for the native Windows build. Add Git for Windows to PATH.');
}
