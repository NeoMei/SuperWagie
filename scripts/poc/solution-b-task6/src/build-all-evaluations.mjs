import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProfileEvaluation } from './build-profile-evaluation.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const candidateRoot = join(repositoryRoot, 'evidence/gate-0/solution-b-v1-ac43a9a9bf75/candidate-root');
const outputBase = resolve(process.argv[2]);
const fixtures = process.argv.slice(3);
if (!outputBase || fixtures.length === 0) {
  console.error('usage: build-all-evaluations.mjs <absolute-output-base> G4-VIDEO-001..005...');
  process.exit(2);
}
mkdirSync(outputBase, { recursive: true, mode: 0o700 });
const summary = [];
for (const fixture of fixtures) {
  const outputRoot = join(outputBase, fixture);
  const result = await buildProfileEvaluation({ fixture, repositoryRoot, candidateRoot, outputRoot });
  summary.push({ fixture, evaluation_path: join(outputRoot, 'evaluation.json'),
    automated_passed: Object.values(result.evaluation.checks).filter(Boolean).length,
    automated_total: Object.keys(result.evaluation.checks).length });
}
writeFileSync(join(outputBase, 'summary.json'), `${JSON.stringify({ schema_id: 'superwagie.task6-evaluation-batch.v1', summary }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
