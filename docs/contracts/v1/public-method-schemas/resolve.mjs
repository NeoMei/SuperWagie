import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultContractsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoSymlinkDirectoryChain(directoryPath) {
  const rawPath = String(directoryPath);
  const absolutePath = path.isAbsolute(rawPath) ? rawPath : `${process.cwd()}${path.sep}${rawPath}`;
  const { root } = path.parse(absolutePath);
  let current = root;
  for (const segment of absolutePath.slice(root.length).split(path.sep).filter(Boolean)) {
    if (segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = fs.lstatSync(current);
    } catch (error) {
      throw new Error(`trusted contracts path ancestor is unavailable: ${current}: ${error.message}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`trusted contracts path ancestor must not be a symlink: ${current}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`trusted contracts path ancestor must be a directory: ${current}`);
    }
  }
}

function trustedSchemaRoots(contractsDir) {
  assertNoSymlinkDirectoryChain(contractsDir);
  const lexicalContractsRoot = path.resolve(contractsDir);
  let contractsStat;
  try {
    contractsStat = fs.lstatSync(lexicalContractsRoot);
  } catch (error) {
    throw new Error(`trusted contracts root is unavailable: ${error.message}`);
  }
  if (contractsStat.isSymbolicLink()) throw new Error('trusted contracts root must not be a symlink');
  if (!contractsStat.isDirectory()) throw new Error('trusted contracts root must be a directory');

  const realContractsRoot = fs.realpathSync(lexicalContractsRoot);
  const lexicalSchemaRoot = path.join(lexicalContractsRoot, 'public-method-schemas');
  let schemaRootStat;
  try {
    schemaRootStat = fs.lstatSync(lexicalSchemaRoot);
  } catch (error) {
    throw new Error(`trusted schema root is unavailable: ${error.message}`);
  }
  if (schemaRootStat.isSymbolicLink()) throw new Error('trusted schema root must not be a symlink');
  if (!schemaRootStat.isDirectory()) throw new Error('trusted schema root must be a directory');

  const realSchemaRoot = fs.realpathSync(lexicalSchemaRoot);
  const expectedRealSchemaRoot = path.join(realContractsRoot, 'public-method-schemas');
  if (realSchemaRoot !== expectedRealSchemaRoot) {
    throw new Error('trusted schema root realpath does not match the contracts-root child');
  }
  return { lexicalSchemaRoot, realSchemaRoot };
}

function assertNoSymlinkParents(schemaRoot, candidate) {
  const relativePath = path.relative(schemaRoot, candidate);
  const segments = relativePath.split(path.sep).filter(Boolean);
  let current = schemaRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`resolved schema parent must not be a symlink: ${current}`);
    if (!metadata.isDirectory()) throw new Error(`resolved schema parent must be a directory: ${current}`);
  }
}

function validateAgainstSchema(value, schema, rootSchema, location = '$', errors = []) {
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) {
      errors.push(`${location}: unsupported external ref ${schema.$ref}`);
      return errors;
    }
    const target = schema.$ref.slice(2).split('/').reduce((node, token) => node?.[token.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
    if (!target) errors.push(`${location}: unresolved ref ${schema.$ref}`);
    else validateAgainstSchema(value, target, rootSchema, location, errors);
    return errors;
  }
  const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
  if (schema.type && actualType !== schema.type && !(schema.type === 'number' && typeof value === 'number')) {
    errors.push(`${location}: expected ${schema.type}, got ${actualType}`);
    return errors;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${location}: value does not match const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location}: value is not in enum`);
  if (typeof value === 'string' && schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${location}: string does not match pattern`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location}: fewer than minItems`);
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) errors.push(`${location}: duplicate array items`);
    if (schema.items) value.forEach((entry, index) => validateAgainstSchema(entry, schema.items, rootSchema, `${location}[${index}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${location}: missing required ${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(`${location}: unexpected property ${key}`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) validateAgainstSchema(value[key], childSchema, rootSchema, `${location}.${key}`, errors);
    }
  }
  return errors;
}

function loadValidatedCatalog(contractsDir) {
  const catalogPath = path.join(contractsDir, 'public-capability-methods.json');
  const catalogSchemaPath = path.join(contractsDir, 'public-capability-methods.schema.json');
  let catalog;
  let catalogSchema;
  try {
    catalog = readJson(catalogPath);
    catalogSchema = readJson(catalogSchemaPath);
  } catch (error) {
    throw new Error(`public capability catalog invalid: ${error.message}`);
  }
  const validationErrors = validateAgainstSchema(catalog, catalogSchema, catalogSchema);
  if (validationErrors.length > 0) throw new Error(`public capability catalog invalid: ${validationErrors.join('; ')}`);
  const names = catalog.methods.map(({ name }) => name);
  const uris = catalog.methods.flatMap(({ input_schema: input, output_schema: output }) => [input, output]);
  if (new Set(names).size !== names.length || new Set(uris).size !== uris.length) {
    throw new Error('public capability catalog invalid: duplicate method name or schema URI');
  }
  return catalog;
}

function catalogEntries(contractsDir) {
  const catalog = loadValidatedCatalog(contractsDir);
  return catalog.methods.flatMap((method) => [
    [method.input_schema, `${method.name}.input.schema.json`],
    [method.output_schema, `${method.name}.output.schema.json`],
  ]);
}

export function resolvePublicMethodSchemaPath(uri, { contractsDir = defaultContractsDir } = {}) {
  const { lexicalSchemaRoot: schemaRoot } = trustedSchemaRoots(contractsDir);
  const entry = catalogEntries(contractsDir).find(([catalogUri]) => catalogUri === uri);
  if (!entry) throw new Error(`schema URI is not present in the public capability catalog: ${uri}`);
  const candidate = path.resolve(schemaRoot, entry[1]);
  if (!isContained(schemaRoot, candidate)) {
    throw new Error(`resolved schema path escapes the public schema root for ${uri}`);
  }
  assertNoSymlinkParents(schemaRoot, candidate);
  return candidate;
}

export function loadPublicMethodSchemaRecord(uri, options = {}) {
  const schemaPath = resolvePublicMethodSchemaPath(uri, options);
  const { realSchemaRoot: realRoot } = trustedSchemaRoots(options.contractsDir || defaultContractsDir);
  let lexicalStat;
  try {
    lexicalStat = fs.lstatSync(schemaPath);
  } catch (error) {
    throw new Error(`resolved schema is not an accessible regular file for ${uri}: ${error.message}`);
  }
  if (lexicalStat.isSymbolicLink()) throw new Error(`resolved schema must not be a symlink for ${uri}`);
  if (!lexicalStat.isFile()) throw new Error(`resolved schema must be a regular file for ${uri}`);

  const realPath = fs.realpathSync(schemaPath);
  if (!isContained(realRoot, realPath)) throw new Error(`resolved schema realpath escapes the public schema root for ${uri}`);

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(schemaPath, fs.constants.O_RDONLY | noFollow);
  let bytes;
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile()) throw new Error(`resolved schema must be a regular file for ${uri}`);
    if (descriptorStat.dev !== lexicalStat.dev || descriptorStat.ino !== lexicalStat.ino) {
      throw new Error(`resolved schema file identity changed while opening ${uri}`);
    }
    bytes = fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  let schema;
  try {
    schema = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`resolved schema is not valid JSON for ${uri}: ${error.message}`);
  }
  if (schema.$id !== uri) throw new Error(`resolved schema $id mismatch for ${uri}`);
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error(`resolved schema draft mismatch for ${uri}`);
  }
  return {
    schema,
    path: realPath,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byte_length: bytes.byteLength,
  };
}

export function loadPublicMethodSchema(uri, options = {}) {
  return loadPublicMethodSchemaRecord(uri, options).schema;
}

export function loadAllPublicMethodSchemas({ contractsDir = defaultContractsDir } = {}) {
  return new Map(catalogEntries(contractsDir).map(([uri]) => [uri, loadPublicMethodSchema(uri, { contractsDir })]));
}
