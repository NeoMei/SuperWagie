import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  loadAllPublicMethodSchemas,
} from '../../../docs/contracts/v1/public-method-schemas/resolve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, '../../..');

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

export function createPublicMethodValidator({
  repoRoot = defaultRepoRoot,
  schemaOverrides = new Map(),
  fixtureOverrides = new Map(),
} = {}) {
  const contractsDir = path.join(repoRoot, 'docs/contracts/v1');
  const schemaDir = path.join(contractsDir, 'public-method-schemas');
  const catalog = readJson(path.join(contractsDir, 'public-capability-methods.json'));
  const fixtureDocument = readJson(path.join(schemaDir, 'method-fixtures.json'));
  const fixtures = new Map(fixtureDocument.methods.map((fixture) => [
    fixture.name,
    fixtureOverrides.get(fixture.name) || fixture,
  ]));
  const schemas = loadAllPublicMethodSchemas({ contractsDir });
  for (const [uri, schema] of schemaOverrides) schemas.set(uri, schema);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  for (const file of [
    'resource-handle.schema.json',
    'ui-query.schema.json',
    'human-gates.schema.json',
    'envelopes.schema.json',
    'capability-manifest.schema.json',
    'states.schema.json',
    'public-capability-methods.schema.json',
  ]) {
    ajv.addSchema(readJson(path.join(contractsDir, file)));
  }
  const commonSchema = readJson(path.join(schemaDir, 'common.schema.json'));
  ajv.addSchema(commonSchema);
  for (const schema of schemas.values()) ajv.addSchema(schema);

  const byMethod = new Map();
  for (const method of catalog.methods) {
    byMethod.set(method.name, {
      definition: method,
      input: ajv.getSchema(method.input_schema),
      output: ajv.getSchema(method.output_schema),
    });
  }

  function validate(direction, methodName, value) {
    const validators = byMethod.get(methodName);
    if (!validators) return { valid: false, errors: [{ message: `unknown public method: ${methodName}` }] };
    const compiled = validators[direction];
    const valid = compiled(value) === true;
    return { valid, errors: valid ? [] : structuredClone(compiled.errors || []) };
  }

  return {
    ajv,
    catalog,
    fixtures,
    schemas,
    commonSchema,
    schemaFor(uri) {
      const schema = schemas.get(uri);
      if (!schema) throw new Error(`unknown public method schema: ${uri}`);
      return schema;
    },
    validateInput(methodName, value) {
      return validate('input', methodName, value);
    },
    validateOutput(methodName, value) {
      return validate('output', methodName, value);
    },
  };
}
