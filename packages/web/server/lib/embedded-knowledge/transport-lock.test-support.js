import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transportFileHash } from './transport-files.js';
import { runTransportNative } from './transport-native.js';
const execute = promisify(execFile);
// Compile the exact production lock package with a stdlib-only stdin test host.
// SQLite/native transactions have their separate real Go suite.
export const transportLockFixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-lock-binary-'));
  await fs.mkdir(path.join(directory, 'transportlock'));
  const source = new URL('../../../../electron/scripts/embedded-knowledge-memory/go/transportlock/', import.meta.url);
  for (const name of await fs.readdir(source)) if (name.endsWith('.go') && !name.endsWith('_test.go')) await fs.copyFile(new URL(name, source), path.join(directory, 'transportlock', name));
  await fs.writeFile(path.join(directory, 'go.mod'), 'module transportlockfixture\n\ngo 1.22\n');
  await fs.writeFile(path.join(directory, 'main.go'), `package main
import("encoding/json";"os";"transportlockfixture/transportlock")
func main(){var r struct{Mode string;LockPath string;LockOwner string};if json.NewDecoder(os.Stdin).Decode(&r)!=nil{os.Exit(1)};var err error;if r.Mode=="lock-acquire"{err=transportlock.Acquire(r.LockPath,r.LockOwner)}else if r.Mode=="lock-release"{err=transportlock.Release(r.LockPath,r.LockOwner)}else{os.Exit(1)};if err!=nil{os.Exit(1)};_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"status":r.Mode})}
`);
  const binary = path.join(directory, 'lock-helper');
  await execute('go', ['build', '-o', binary, '.'], { cwd: directory, timeout: 60_000 });
  const options = { binary, binarySha256: await transportFileHash(binary), configDir: directory };
  return { ...options, cleanup: () => fs.rm(directory, { recursive: true, force: true }), executeLock: (request) => runTransportNative({ ...options, request }) };
};
