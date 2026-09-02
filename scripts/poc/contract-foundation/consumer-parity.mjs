#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepo = path.resolve(here, '../../..');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? '';
}

const repoArgument = arg('--repo-root', defaultRepo);
const fixture = arg('--fixture', 'CF-PROTOCOL-002');
if (!path.isAbsolute(repoArgument) || !/^CF-PROTOCOL-[0-9]{3}$/.test(fixture)) {
  console.error('invalid parity arguments');
  process.exit(2);
}
const repo = path.resolve(repoArgument);

const commands = [
  {
    consumer: 'typescript',
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      path.join(here, 'consumers/typescript-consumer.ts'),
      '--repo-root', repo,
      '--fixture', fixture,
    ],
  },
  {
    consumer: 'python',
    command: 'uv',
    args: [
      'run', '--project', path.join(here, 'consumers/python-consumer'), '--frozen',
      'python', path.join(here, 'consumers/python-consumer/consumer.py'),
      '--repo-root', repo,
      '--fixture', fixture,
    ],
  },
  {
    consumer: 'rust',
    command: 'cargo',
    args: [
      'run', '--locked', '--quiet',
      '--manifest-path', path.join(here, 'consumers/rust-consumer/Cargo.toml'),
      '--', '--repo-root', repo,
      '--fixture', fixture,
    ],
  },
];

function runConsumer(specification) {
  const completed = spawnSync(specification.command, specification.args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0 && completed.status !== 1) {
    throw new Error(`${specification.consumer} consumer failed (${completed.status}): ${completed.stderr || completed.stdout}`);
  }
  let report;
  try {
    report = JSON.parse(completed.stdout);
  } catch (error) {
    throw new Error(`${specification.consumer} emitted invalid JSON: ${error}`);
  }
  if (report.consumer !== specification.consumer || report.fixture !== fixture || !Array.isArray(report.cases)) {
    throw new Error(`${specification.consumer} emitted an invalid report identity`);
  }
  return report;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

try {
  const consumers = commands.map(runConsumer);
  const caseIds = consumers[0].cases.map(({ case_id: caseId }) => caseId);
  const failures = [];
  for (const consumer of consumers) {
    const ids = consumer.cases.map(({ case_id: caseId }) => caseId);
    if (JSON.stringify(ids) !== JSON.stringify(caseIds)) {
      failures.push({ case_id: '*', reason: `${consumer.consumer}:case-set-mismatch` });
    }
  }
  for (let index = 0; index < caseIds.length; index += 1) {
    const entries = consumers.map((consumer) => consumer.cases[index]);
    if (entries.some(({ passed }) => passed !== true)) {
      failures.push({ case_id: caseIds[index], reason: 'fixture-expectation-failed' });
      continue;
    }
    const observations = entries.map(({ observed }) => JSON.stringify(canonical(observed)));
    if (new Set(observations).size !== 1) {
      failures.push({ case_id: caseIds[index], reason: 'consumer-observation-mismatch' });
    }
  }
  if (consumers.some(({ pass }) => pass !== true)) {
    failures.push({ case_id: '*', reason: 'consumer-reported-failure' });
  }

  const report = {
    schema_id: 'superwagie.contract-consumer-parity.v1',
    schema_version: 1,
    fixture,
    pass: failures.length === 0,
    summary: {
      fixture_cases: caseIds.length,
      agreed_cases: caseIds.length - new Set(failures.filter(({ case_id: caseId }) => caseId !== '*').map(({ case_id: caseId }) => caseId)).size,
      failed_cases: failures.length,
    },
    failures,
    consumers,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
