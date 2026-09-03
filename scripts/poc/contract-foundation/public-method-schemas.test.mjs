import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const contractsDir = path.join(repoRoot, 'docs/contracts/v1');
const catalog = JSON.parse(readFileSync(path.join(contractsDir, 'public-capability-methods.json'), 'utf8'));
const resolverPath = path.join(contractsDir, 'public-method-schemas/resolve.mjs');
const validatorPath = path.join(here, 'public-method-validator.mjs');
const inventoryPath = path.join(contractsDir, 'public-method-schemas/method-contract-inventory.json');
const inventoryValidatorPath = path.join(here, 'public-method-inventory-validator.mjs');
const realTmpDir = realpathSync(tmpdir());

test('independent method inventory locks catalog, schemas, fixtures, and rejects placeholder mutation', async () => {
  assert.ok(existsSync(inventoryPath), 'independent method contract inventory is missing');
  assert.ok(existsSync(inventoryValidatorPath), 'method inventory validator is missing');
  const { auditPublicMethodContracts } = await import(pathToFileURL(inventoryValidatorPath));
  const baseline = auditPublicMethodContracts({ repoRoot });
  assert.equal(baseline.valid, true, baseline.errors.join('\n'));
  assert.equal(baseline.methods_checked, 34);
  assert.equal(baseline.schema_documents_checked, 68);
  assert.equal(baseline.fixture_documents_checked, 68);
  assert.equal(baseline.semantic_directions_reviewed, 68);
  assert.equal(baseline.semantic_rules_checked, 2);

  const workspaceRead = catalog.methods.find(({ name }) => name === 'workspace.read');
  const placeholder = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: workspaceRead.input_schema,
    type: 'object',
    additionalProperties: false,
    required: ['placeholder'],
    properties: { placeholder: { type: 'string' } },
  };
  const mutated = auditPublicMethodContracts({
    repoRoot,
    schemaOverrides: new Map([[workspaceRead.input_schema, placeholder]]),
  });
  assert.equal(mutated.valid, false, 'placeholder mutation escaped the independent inventory');
  assert.ok(mutated.errors.some((message) => /workspace\.read.*logical_path/.test(message)), mutated.errors.join('\n'));
});

test('independent inventory rejects simultaneous schema and fixture deletion of cross-field semantics', async () => {
  const { auditPublicMethodContracts } = await import(pathToFileURL(inventoryValidatorPath));
  const { createPublicMethodValidator } = await import(pathToFileURL(validatorPath));
  const validator = createPublicMethodValidator({ repoRoot });

  const chatDefinition = catalog.methods.find(({ name }) => name === 'ai.chat');
  const chatSchema = structuredClone(validator.schemaFor(chatDefinition.output_schema));
  delete chatSchema.properties.text;
  delete chatSchema.properties.structured_result;
  delete chatSchema.anyOf;
  const chatFixture = structuredClone(validator.fixtures.get('ai.chat'));
  delete chatFixture.output.text;
  delete chatFixture.output.structured_result;
  const chatMutation = auditPublicMethodContracts({
    repoRoot,
    schemaOverrides: new Map([[chatDefinition.output_schema, chatSchema]]),
    fixtureOverrides: new Map([['ai.chat', chatFixture]]),
  });
  assert.equal(chatMutation.valid, false, 'ai.chat business result deletion escaped inventory');
  assert.ok(
    chatMutation.errors.some((message) => /ai\.chat output.*(?:at_least_one|text.*structured_result)/.test(message)),
    chatMutation.errors.join('\n'),
  );

  const taskDefinition = catalog.methods.find(({ name }) => name === 'task.update');
  const taskSchema = structuredClone(validator.schemaFor(taskDefinition.input_schema));
  delete taskSchema.properties.patch.minProperties;
  const taskFixture = structuredClone(validator.fixtures.get('task.update'));
  taskFixture.input.patch = {};
  const taskMutation = auditPublicMethodContracts({
    repoRoot,
    schemaOverrides: new Map([[taskDefinition.input_schema, taskSchema]]),
    fixtureOverrides: new Map([['task.update', taskFixture]]),
  });
  assert.equal(taskMutation.valid, false, 'task.update empty patch escaped inventory');
  assert.ok(taskMutation.errors.some((message) => /task\.update input.*min_properties/.test(message)), taskMutation.errors.join('\n'));
});

test('all 34 active methods resolve 68 distinct Draft 2020-12 schemas with exact catalog ids', async () => {
  assert.equal(catalog.schema_resolution_status, 'resolved');
  assert.equal(catalog.methods.length, 34);
  const uris = catalog.methods.flatMap(({ input_schema: input, output_schema: output }) => [input, output]);
  assert.equal(new Set(uris).size, 68);
  assert.ok(existsSync(resolverPath), 'deterministic public method schema resolver is missing');

  const { loadPublicMethodSchema, resolvePublicMethodSchemaPath } = await import(pathToFileURL(resolverPath));
  for (const uri of uris) {
    const firstPath = resolvePublicMethodSchemaPath(uri, { contractsDir });
    const secondPath = resolvePublicMethodSchemaPath(uri, { contractsDir });
    assert.equal(firstPath, secondPath, `${uri} did not resolve deterministically`);
    assert.ok(existsSync(firstPath), `${uri} resolved to a missing file`);
    const schema = loadPublicMethodSchema(uri, { contractsDir });
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.$id, uri);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${uri} has no required core fields`);
    assert.ok(Object.keys(schema.properties || {}).length > 0, `${uri} has no typed properties`);
  }
  assert.throws(
    () => loadPublicMethodSchema('superwagie://schemas/v1/not.cataloged.input', { contractsDir }),
    /not present in the public capability catalog/,
  );
});

test('every method validates independent minimal input/output and rejects a forged trusted field', async () => {
  assert.ok(existsSync(validatorPath), 'public method schema validator is missing');
  const { createPublicMethodValidator } = await import(pathToFileURL(validatorPath));
  const validator = createPublicMethodValidator({ repoRoot });
  assert.equal(validator.fixtures.size, 34);

  for (const method of catalog.methods) {
    const fixture = validator.fixtures.get(method.name);
    assert.ok(fixture, `missing recognizable fixture for ${method.name}`);
    assert.equal(validator.validateInput(method.name, fixture.input).valid, true, `${method.name} minimal input`);
    assert.equal(validator.validateOutput(method.name, fixture.output).valid, true, `${method.name} minimal output`);
    assert.equal(
      validator.validateInput(method.name, { ...fixture.input, actor_context: { user_id: 'forged' } }).valid,
      false,
      `${method.name} accepted caller-forged trusted context`,
    );
    const requiredInput = validator.schemaFor(method.input_schema).required[0];
    const missingCore = structuredClone(fixture.input);
    delete missingCore[requiredInput];
    assert.equal(validator.validateInput(method.name, missingCore).valid, false, `${method.name} accepted missing ${requiredInput}`);
  }
});

test('runtime, artifact, and Managed AI schemas reject path and internal routing leaks', async () => {
  assert.ok(existsSync(validatorPath), 'public method schema validator is missing');
  const { createPublicMethodValidator } = await import(pathToFileURL(validatorPath));
  const validator = createPublicMethodValidator({ repoRoot });

  const runtime = structuredClone(validator.fixtures.get('runtime.probe').output);
  runtime.absolute_path = '/Applications/WPS Office.app';
  assert.equal(validator.validateOutput('runtime.probe', runtime).valid, false);

  const wps = structuredClone(validator.fixtures.get('wps.apply_plan').input);
  wps.path = '/Users/example/private.docx';
  assert.equal(validator.validateInput('wps.apply_plan', wps).valid, false);

  for (const name of ['ai.chat', 'ai.reason', 'ai.vision', 'ai.ocr', 'ai.generate_image', 'ai.generate_audio']) {
    for (const forbidden of ['provider', 'model', 'api_key', 'token', 'internal_cost']) {
      const output = structuredClone(validator.fixtures.get(name).output);
      output[forbidden] = 'forged';
      assert.equal(validator.validateOutput(name, output).valid, false, `${name} leaked ${forbidden}`);
    }
  }
});

test('logical paths and ArtifactRef logical paths reject traversal and encoding bypasses', async () => {
  const { createPublicMethodValidator } = await import(pathToFileURL(validatorPath));
  const validator = createPublicMethodValidator({ repoRoot });
  const maliciousPaths = [
    '/workspace/../secret.md', '/workspace/./secret.md', '/workspace//secret.md',
    '/workspace\\secret.md', '/workspace/%2e%2e/secret.md', '/workspace/%2E%2E/secret.md',
    '/workspace/%252e%252e/secret.md', '/workspace/trailing/',
  ];
  for (const logical_path of maliciousPaths) {
    const read = structuredClone(validator.fixtures.get('workspace.read').input);
    read.logical_path = logical_path;
    assert.equal(validator.validateInput('workspace.read', read).valid, false, `workspace.read accepted ${logical_path}`);

    const diagram = structuredClone(validator.fixtures.get('diagram.create').input);
    diagram.target_logical_path = logical_path.replace('/workspace', '/output');
    assert.equal(validator.validateInput('diagram.create', diagram).valid, false, `diagram.create accepted ${diagram.target_logical_path}`);

    const execution = structuredClone(validator.fixtures.get('task.start_execution').input);
    execution.working_set.logical_paths = [logical_path];
    assert.equal(validator.validateInput('task.start_execution', execution).valid, false, `working_set accepted ${logical_path}`);
  }

  const wps = structuredClone(validator.fixtures.get('wps.apply_plan').input);
  wps.source_artifact.logical_path = '/output/../workspace/secret.docx';
  assert.equal(validator.validateInput('wps.apply_plan', wps).valid, false, 'ArtifactRef accepted traversal');
});

test('browser.fetch accepts declared HTTPS policy only and rejects local/credential/redirect forgeries', async () => {
  const { createPublicMethodValidator } = await import(pathToFileURL(validatorPath));
  const validator = createPublicMethodValidator({ repoRoot });
  const invalidUrls = [
    'file:///etc/passwd', 'data:text/plain,secret', 'javascript:alert(1)',
    'http://example.com', 'https://localhost/admin', 'https://localhost.localdomain/admin',
    'https://127.0.0.1:8443/admin', 'https://[::1]/admin',
    'https://2130706433/admin', 'https://0x7f000001/admin', 'https://0177.0.0.1/admin',
    'https://127.1/admin', 'https://0x7f.0.0.1/admin',
    'https://LOCALHOST/admin', 'https://LocalHost./admin', 'https://sub.localhost/admin',
    'https://sub.LOCALHOST/admin', 'https://localhost./admin', 'https://localhost.localdomain./admin',
    'https://ip6-localhost/admin', 'https://ip6-loopback/admin', 'https://broadcasthost/admin',
    'https://printer.local/admin', 'https://printer.local./admin',
    'https://host.docker.internal/admin', 'https://gateway.docker.internal/admin',
    'https://host.containers.internal/admin', 'https://127.0.0.1.nip.io/admin',
    'https://foo.localtest.me/admin', 'https://EXAMPLE.com/admin', 'https://example.com./admin',
    'https://xn--e1afmkfd.xn--p1ai/admin', 'https://例子.测试/admin',
    'https://[::ffff:127.0.0.1]/admin', 'https://[0:0:0:0:0:0:0:1]/admin',
    'https://user:password@example.com/private', 'https://example.com@127.0.0.1/admin',
  ];
  for (const url of invalidUrls) {
    const input = structuredClone(validator.fixtures.get('browser.fetch').input);
    input.url = url;
    assert.equal(validator.validateInput('browser.fetch', input).valid, false, `browser.fetch accepted ${url}`);
  }
  const forgedRedirect = structuredClone(validator.fixtures.get('browser.fetch').input);
  forgedRedirect.redirect_url = 'https://127.0.0.1/admin';
  assert.equal(validator.validateInput('browser.fetch', forgedRedirect).valid, false);
  const unsafePolicy = structuredClone(validator.fixtures.get('browser.fetch').input);
  unsafePolicy.redirect_policy = 'follow_any';
  assert.equal(validator.validateInput('browser.fetch', unsafePolicy).valid, false);

  for (const url of ['https://example.com/data', 'https://api.example.com:443/data?source=fixture']) {
    const input = structuredClone(validator.fixtures.get('browser.fetch').input);
    input.url = url;
    assert.equal(validator.validateInput('browser.fetch', input).valid, true, `browser.fetch rejected canonical ${url}`);
  }

  const forgedFinalUrl = structuredClone(validator.fixtures.get('browser.fetch').output);
  forgedFinalUrl.metadata.final_url = 'https://Sub.LocalHost/admin';
  assert.equal(validator.validateOutput('browser.fetch', forgedFinalUrl).valid, false, 'browser.fetch output accepted noncanonical local final_url');
});

test('Managed AI safe structured output rejects nested, array, case, alias, and text leaks', async () => {
  const { createPublicMethodValidator } = await import(pathToFileURL(validatorPath));
  const validator = createPublicMethodValidator({ repoRoot });
  const attacks = [
    { Provider: 'OpenAI' },
    { provider_name: 'OpenAI' },
    { details: [{ MODEL_NAME: 'gpt-private' }] },
    { meta: { apiKey: 'secret' } },
    { usage: [{ input_tokens: 123 }] },
    { billing: { internalCost: 9 } },
    { vendor: 'internal-vendor' },
    { engine: 'private-engine' },
    [{ Backend: 'private-backend' }],
  ];
  for (const name of ['ai.chat', 'ai.reason', 'ai.vision']) {
    for (const attack of attacks) {
      const output = structuredClone(validator.fixtures.get(name).output);
      delete output.text;
      output.structured_result = attack;
      assert.equal(validator.validateOutput(name, output).valid, false, `${name} accepted ${JSON.stringify(attack)}`);
    }
  }
  const chat = structuredClone(validator.fixtures.get('ai.chat').output);
  chat.text = 'Provider=OpenAI model=gpt-private api_key=sk-secret';
  assert.equal(validator.validateOutput('ai.chat', chat).valid, false, 'ai.chat text accepted explicit internal routing leak');
});

test('resolver validates catalog, containment, regular files, no symlinks, and byte identity', async () => {
  const {
    loadPublicMethodSchemaRecord,
    resolvePublicMethodSchemaPath,
  } = await import(pathToFileURL(resolverPath));
  const uri = catalog.methods[0].input_schema;
  const record = loadPublicMethodSchemaRecord(uri, { contractsDir });
  assert.equal(record.sha256, `sha256:${createHash('sha256').update(readFileSync(record.path)).digest('hex')}`);
  assert.ok(record.byte_length > 0);
  assert.equal(record.path, resolvePublicMethodSchemaPath(uri, { contractsDir }));

  const maliciousRoot = mkdtempSync(path.join(realTmpDir, 'superwagie-resolver-catalog-'));
  const maliciousContracts = path.join(maliciousRoot, 'contracts');
  cpSync(contractsDir, maliciousContracts, { recursive: true });
  const maliciousCatalogPath = path.join(maliciousContracts, 'public-capability-methods.json');
  const maliciousCatalog = JSON.parse(readFileSync(maliciousCatalogPath, 'utf8'));
  maliciousCatalog.methods[0].name = '../escape';
  writeFileSync(maliciousCatalogPath, `${JSON.stringify(maliciousCatalog, null, 2)}\n`);
  assert.throws(() => resolvePublicMethodSchemaPath(uri, { contractsDir: maliciousContracts }), /catalog.*invalid/i);

  const symlinkRoot = mkdtempSync(path.join(realTmpDir, 'superwagie-resolver-symlink-'));
  const symlinkContracts = path.join(symlinkRoot, 'contracts');
  cpSync(contractsDir, symlinkContracts, { recursive: true });
  const target = resolvePublicMethodSchemaPath(uri, { contractsDir: symlinkContracts });
  const external = path.join(symlinkRoot, 'external.json');
  writeFileSync(external, readFileSync(target));
  rmSync(target);
  symlinkSync(external, target);
  assert.throws(() => loadPublicMethodSchemaRecord(uri, { contractsDir: symlinkContracts }), /symlink|regular file/i);

  const directoryRoot = mkdtempSync(path.join(realTmpDir, 'superwagie-resolver-directory-'));
  const directoryContracts = path.join(directoryRoot, 'contracts');
  cpSync(contractsDir, directoryContracts, { recursive: true });
  const directoryTarget = resolvePublicMethodSchemaPath(uri, { contractsDir: directoryContracts });
  rmSync(directoryTarget);
  mkdirSync(directoryTarget);
  assert.throws(() => loadPublicMethodSchemaRecord(uri, { contractsDir: directoryContracts }), /regular file/i);

  const rootLinkBase = mkdtempSync(path.join(realTmpDir, 'superwagie-resolver-root-link-'));
  const rootLinkContracts = path.join(rootLinkBase, 'contracts');
  cpSync(contractsDir, rootLinkContracts, { recursive: true });
  const linkedSchemaRoot = path.join(rootLinkContracts, 'public-method-schemas');
  const externalSchemaRoot = path.join(rootLinkBase, 'external-public-method-schemas');
  cpSync(linkedSchemaRoot, externalSchemaRoot, { recursive: true });
  rmSync(linkedSchemaRoot, { recursive: true });
  symlinkSync(externalSchemaRoot, linkedSchemaRoot);
  assert.throws(
    () => loadPublicMethodSchemaRecord(uri, { contractsDir: rootLinkContracts }),
    /schema root.*symlink|trusted schema root/i,
  );

  const contractsLinkBase = mkdtempSync(path.join(realTmpDir, 'superwagie-resolver-contracts-link-'));
  const actualContracts = path.join(contractsLinkBase, 'actual-contracts');
  const linkedContracts = path.join(contractsLinkBase, 'linked-contracts');
  cpSync(contractsDir, actualContracts, { recursive: true });
  symlinkSync(actualContracts, linkedContracts);
  assert.throws(
    () => loadPublicMethodSchemaRecord(uri, { contractsDir: linkedContracts }),
    /contracts (?:root|path ancestor).*symlink|trusted contracts root/i,
  );

  const ancestorLinkBase = mkdtempSync(path.join(realTmpDir, 'superwagie-resolver-ancestor-link-'));
  const actualParent = path.join(ancestorLinkBase, 'actual-parent');
  const linkedParent = path.join(ancestorLinkBase, 'linked-parent');
  const ancestorLinkedContracts = path.join(linkedParent, 'v1');
  mkdirSync(actualParent);
  cpSync(contractsDir, path.join(actualParent, 'v1'), { recursive: true });
  symlinkSync(actualParent, linkedParent);
  assert.throws(
    () => loadPublicMethodSchemaRecord(uri, { contractsDir: ancestorLinkedContracts }),
    /contracts path ancestor.*symlink|trusted contracts root/i,
  );
  const normalizedAncestorBypass = `${linkedParent}${path.sep}..${path.sep}actual-parent${path.sep}v1`;
  assert.throws(
    () => loadPublicMethodSchemaRecord(uri, { contractsDir: normalizedAncestorBypass }),
    /contracts path ancestor.*symlink|trusted contracts root/i,
  );
});
