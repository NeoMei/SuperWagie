import { existsSync } from 'node:fs';
import path from 'node:path';

/** Node cannot execute npm.cmd directly on Windows. Keep arguments out of a shell. */
export function resolveNpmCommand({ platform = process.platform, env = process.env, node = process.execPath } = {}) {
  if (platform !== 'win32') return { command: 'npm', args: [] };

  const inherited = env.npm_execpath;
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates = [
    inherited && path.basename(inherited).toLowerCase() === 'npm-cli.js' ? inherited : null,
    ...[...pathValue.split(';').filter(Boolean), path.dirname(node)].map((directory) => (
      path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    )),
  ];
  const cli = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!cli) throw new Error('npm CLI not found. Install Node.js with npm or add its installation directory to PATH.');
  return { command: node, args: [cli] };
}
