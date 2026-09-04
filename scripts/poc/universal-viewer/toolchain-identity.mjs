import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const NODE_IDENTITY = 'v24.18.0';
export const NPM_IDENTITY = '11.16.0';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

const TOOLCHAIN_BY_PLATFORM = Object.freeze({
  'macos-15-arm64': Object.freeze({
    node_sha256: 'bf0cea6ab3631b6b53a9709ed54d62608dd0725187426d34d4d6af6644c5197f',
    npm_tree_sha256: '0434cdfe04030cc02943f27eb1cd958414f1092dcd18df610e571e443a9140e5',
    isolation_toolchain: Object.freeze({
      source_sha256: 'sha256:98ea43d0860cbf7fa35126e28b3081cadb8c5329cf92f7e2683e0a6f0352a1bc',
      compiler_sha256: 'sha256:f30550eab15fdf5ab8c0dc54c52679711241e5d4b636b027e18c09fef531775d',
      compiler_version: 'Apple clang version 21.0.0 (clang-2100.1.1.101)',
      sdk_version: '26.5',
      sdk_settings_sha256: 'sha256:f8d005f09381389167f9e0aeaa169bc9e7dff162ef22ca2fd8e98df7ff1acafe',
      helper_sha256: 'sha256:eec9a763004c560f945ea7c918cf173d56384daf2144f80aba596a9bd87f3161',
    }),
  }),
  'windows-11-x64': Object.freeze({
    node_sha256: '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de',
    npm_tree_sha256: '8f6d14c6934a5b0a55e8464ef12bd7d5fc3d24f36d2d4d1a12c5fe44265ecdde',
  }),
});

function hostRuntimeFamilyId() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-15-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-11-x64';
  return `${process.platform}-${process.arch}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashCanonicalTree(root) {
  const digest = createHash('sha256');
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        digest.update(relative);
        digest.update('\0');
        digest.update(readFileSync(absolute));
        digest.update('\0');
      } else throw new Error('npm runtime tree contains an unsupported entry');
    }
  };
  visit(root);
  return digest.digest('hex');
}

export function npmRuntimeIdentityForPlatform(platform) {
  const identity = TOOLCHAIN_BY_PLATFORM[platform];
  if (!identity) throw new Error('platform has no admitted Node/npm runtime identity');
  return `npm@${NPM_IDENTITY}#sha256:${identity.npm_tree_sha256}`;
}

export function toolchainIdentityForPlatform(platform) {
  const identity = TOOLCHAIN_BY_PLATFORM[platform];
  if (!identity) throw new Error('platform has no admitted Node/npm runtime identity');
  return Object.freeze({
    node: NODE_IDENTITY.slice(1),
    node_executable_sha256: `sha256:${identity.node_sha256}`,
    npm: NPM_IDENTITY,
    npm_runtime_identity: npmRuntimeIdentityForPlatform(platform),
    npm_tree_sha256: `sha256:${identity.npm_tree_sha256}`,
    isolation_toolchain: identity.isolation_toolchain,
  });
}

export function resolveAdmittedNodeNpmRuntime() {
  const platform = hostRuntimeFamilyId();
  const expected = TOOLCHAIN_BY_PLATFORM[platform];
  if (!expected) throw new Error('host platform has no admitted Node/npm runtime identity');
  if (process.version !== NODE_IDENTITY || !path.isAbsolute(process.execPath)
    || !lstatSync(process.execPath).isFile() || realpathSync(process.execPath) !== process.execPath) {
    throw new Error('admitted Node executable is unavailable');
  }
  const nodeSha256 = sha256(readFileSync(process.execPath));
  if (nodeSha256 !== expected.node_sha256) throw new Error('admitted Node executable hash does not match its pinned identity');
  const npmRoot = [
    path.resolve(path.dirname(process.execPath), 'node_modules', 'npm'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'),
  ].find((candidate) => existsSync(path.join(candidate, 'bin', 'npm-cli.js')));
  if (!npmRoot) throw new Error('admitted npm runtime tree is unavailable');
  const npmCli = path.join(npmRoot, 'bin', 'npm-cli.js');
  const npmPackage = JSON.parse(readFileSync(path.join(npmRoot, 'package.json'), 'utf8'));
  if (npmPackage.version !== NPM_IDENTITY || !lstatSync(npmCli).isFile() || realpathSync(npmCli) !== npmCli) {
    throw new Error('admitted npm CLI identity is unavailable');
  }
  const npmTreeSha256 = hashCanonicalTree(npmRoot);
  if (npmTreeSha256 !== expected.npm_tree_sha256) throw new Error('admitted npm runtime tree hash does not match its pinned identity');
  return Object.freeze({
    platform,
    node_executable: process.execPath,
    node_sha256: nodeSha256,
    npm_cli: npmCli,
    npm_tree_sha256: npmTreeSha256,
    npm_identity: npmRuntimeIdentityForPlatform(platform),
  });
}
