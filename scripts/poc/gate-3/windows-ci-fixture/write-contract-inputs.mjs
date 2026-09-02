#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parse(argv) {
  const result = {};
  const names = new Map([
    ['--fixture-root', 'fixtureRoot'], ['--profile', 'profile'], ['--attestation', 'attestation']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key || index + 1 >= argv.length || result[key]) throw new Error(`invalid argument: ${argv[index]}`);
    result[key] = path.resolve(argv[++index]);
  }
  if (!result.fixtureRoot || !result.profile || !result.attestation) throw new Error('contract input paths required');
  return result;
}

const args = parse(process.argv.slice(2));
const bridgeRelativePath = 'skills/WPSComposer/__init__.py';
const bridge = path.join(args.fixtureRoot, bridgeRelativePath);
const bridgeSha256 = createHash('sha256').update(await readFile(bridge)).digest('hex');
const profile = {
  schema_id: 'superwagie.review-machine-profile.v1',
  schema_version: 1,
  profile_id: 'windows-2022-controlled-contract-v1',
  platform: 'windows-11-x64',
  representative: true,
  wps: {
    application: 'WPS',
    exact_version: '12.1.0.17900',
    bridge_identity: `sha256:${bridgeSha256}`,
    bridge_relative_path: bridgeRelativePath
  },
  render_options: { quality: 'authoritative', contract_fixture: 'controlled-fake-wps' }
};
const attestation = {
  schema_id: 'superwagie.codex-never-installed-attestation.v1',
  platform: 'windows-11-x64',
  applications_absent: true,
  operator: 'office-reviewer-windows-contract',
  attested_at: new Date().toISOString()
};
await mkdir(path.dirname(args.profile), { recursive: true });
await writeFile(args.profile, `${JSON.stringify(profile, null, 2)}\n`);
await writeFile(args.attestation, `${JSON.stringify(attestation, null, 2)}\n`);
