import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../scripts/poc/contract-foundation/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats');

test('real authenticated Core Agent messages conform to the closed UI contract', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const file of ['ui-query.schema.json', 'states.schema.json', 'product-ui-agent-state.schema.json']) {
    const schema = JSON.parse(readFileSync(new URL(`../../../docs/contracts/v1/${file}`, import.meta.url), 'utf8'));
    assert.equal(ajv.validateSchema(schema), true, ajv.errorsText());
    ajv.addSchema(schema);
  }
  const validate = ajv.getSchema('https://superwagie.example/contracts/v1/product-ui-agent-state.schema.json');
  const output = execFileSync('cargo', ['test', '--locked', '--manifest-path', 'crates/product-core/Cargo.toml',
    '--test', 'agent_query_transport', '--', '--nocapture'], { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  const lines = output.split('\n').filter((line) => line.startsWith('AGENT_QUERY_CONTRACT:'));
  assert.equal(lines.length, 1, 'missing actual Core contract messages');
  const messages = JSON.parse(lines[0].slice('AGENT_QUERY_CONTRACT:'.length));
  assert.equal(messages.length, 8);
  for (const message of messages) {
    assert.equal(validate(message), true, ajv.errorsText(validate.errors));
  }
  for (const field of ['project_id', 'actor_context', 'wallet_id', 'permission_context']) {
    const forged = structuredClone(messages[0]);
    forged.params[field] = 'forged';
    assert.equal(validate(forged), false, field);
  }
  const corrupted = structuredClone(messages[2]);
  corrupted.payload.state = 'paused';
  assert.equal(validate(corrupted), false);
  const leaked = structuredClone(messages[2]);
  leaked.payload.root_path = '/not-permitted';
  assert.equal(validate(leaked), false);
});
