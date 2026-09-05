import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

test('product workspace fixtures agree with the closed internal UI contract', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(
    repoRoot,
    'docs/contracts/v1/product-ui-workspace.schema.json',
  ), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(
    repoRoot,
    'fixtures/local-mac-workspace/contracts/product-ui-workspace.json',
  ), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  assert.equal(ajv.validateSchema(schema), true, ajv.errorsText(ajv.errors));
  ajv.addSchema(schema);
  const validators = new Map(Object.keys(schema.$defs).map((definition) => [
    definition,
    ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` }),
  ]));

  for (const item of fixture.cases) {
    const validate = validators.get(item.definition);
    assert.ok(validate, `missing definition ${item.definition}`);
    assert.equal(validate(item.instance), item.expect === 'valid', item.case_id);
  }
});
