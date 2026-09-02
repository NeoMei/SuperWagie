import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicMethodValidator } from './public-method-validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, '../../..');
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

function descriptorMatches(schema, descriptor) {
  if (!schema || typeof schema !== 'object') return false;
  if (descriptor.startsWith('ref:')) {
    return typeof schema.$ref === 'string' && schema.$ref.endsWith(`/$defs/${descriptor.slice(4)}`);
  }
  if (descriptor.startsWith('array:ref:')) {
    return schema.type === 'array'
      && typeof schema.items?.$ref === 'string'
      && schema.items.$ref.endsWith(`/$defs/${descriptor.slice('array:ref:'.length)}`);
  }
  if (descriptor === 'array:object') return schema.type === 'array' && schema.items?.type === 'object';
  if (descriptor === 'array:string') return schema.type === 'array' && schema.items?.type === 'string';
  if (descriptor === 'array:enum') return schema.type === 'array' && Array.isArray(schema.items?.enum);
  if (descriptor === 'enum') return Array.isArray(schema.enum) && schema.enum.length > 0;
  if (descriptor === 'https_uri') {
    return (typeof schema.$ref === 'string' && schema.$ref.endsWith('/$defs/PublicHttpsUrl'))
      || (schema.type === 'string' && schema.format === 'uri' && String(schema.pattern || '').startsWith('^https://'));
  }
  return schema.type === descriptor;
}

function nodeAtPropertyPath(schema, propertyPath) {
  let node = schema;
  for (const field of propertyPath) node = node?.properties?.[field];
  return node;
}

function collectSemanticFeatures(schema) {
  const features = [];
  function visit(node, propertyPath = []) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const keyword of ['anyOf', 'oneOf', 'dependentRequired', 'dependentSchemas']) {
      if (keyword in node) features.push({ keyword, path: propertyPath.join('.') });
    }
    if (Number.isInteger(node.minProperties) && node.minProperties > 0) {
      features.push({ keyword: 'minProperties', path: propertyPath.join('.') });
    }
    for (const [field, child] of Object.entries(node.properties || {})) visit(child, [...propertyPath, field]);
    if (node.items) visit(node.items, [...propertyPath, '*']);
  }
  visit(schema);
  return features;
}

function ruleCoversFeature(rule, feature) {
  const path = Array.isArray(rule.path) ? rule.path.join('.') : '';
  if (rule.kind === 'nested_min_properties') return feature.keyword === 'minProperties' && feature.path === path;
  if (rule.kind === 'at_least_one' || rule.kind === 'exactly_one') {
    return feature.keyword === rule.keyword && feature.path === path;
  }
  if (rule.kind === 'dependent_required') {
    return ['dependentRequired', 'dependentSchemas'].includes(feature.keyword) && feature.path === path;
  }
  return false;
}

function checkSemanticRule({ errors, rule, schema, fixtureValue, validateFixture }) {
  const prefix = `${rule.method} ${rule.direction} semantic ${rule.kind}`;
  const node = nodeAtPropertyPath(schema, rule.path || []);
  if (!node) {
    errors.push(`${prefix} path ${(rule.path || []).join('.') || '<root>'} is missing`);
    return;
  }
  if (rule.kind === 'nested_min_properties') {
    if (!Number.isInteger(node.minProperties) || node.minProperties < rule.minimum) {
      errors.push(`${prefix} requires minProperties >= ${rule.minimum}`);
    }
    const fixtureNode = (rule.path || []).reduce((value, field) => value?.[field], fixtureValue);
    if (!fixtureNode || typeof fixtureNode !== 'object' || Object.keys(fixtureNode).length < rule.minimum) {
      errors.push(`${prefix} fixture does not satisfy min_properties ${rule.minimum}`);
    }
    return;
  }

  if (rule.kind === 'at_least_one' || rule.kind === 'exactly_one') {
    const fields = Object.entries(rule.fields || {});
    const keyword = rule.kind === 'exactly_one' ? 'oneOf' : 'anyOf';
    if (rule.keyword !== keyword || !Array.isArray(node[keyword])) {
      errors.push(`${prefix} requires ${keyword}`);
      return;
    }
    for (const [field, descriptor] of fields) {
      if (!descriptorMatches(node.properties?.[field], descriptor)) {
        errors.push(`${prefix} field ${field} does not match ${descriptor}`);
      }
      if (!node[keyword].some((branch) => Array.isArray(branch.required) && branch.required.includes(field))) {
        errors.push(`${prefix} ${keyword} does not require alternative ${field}`);
      }
    }
    const present = fields.filter(([field]) => field in (fixtureValue || {}));
    const fixtureOk = rule.kind === 'exactly_one' ? present.length === 1 : present.length >= 1;
    if (!fixtureOk) errors.push(`${prefix} fixture does not satisfy ${keyword}`);
    const missingAll = structuredClone(fixtureValue);
    for (const [field] of fields) delete missingAll[field];
    if (validateFixture(missingAll).valid) errors.push(`${prefix} schema accepts a fixture with every alternative missing`);
    return;
  }

  if (rule.kind === 'dependent_required') {
    const required = node.dependentRequired?.[rule.trigger];
    if (!Array.isArray(required) || !rule.fields.every((field) => required.includes(field))) {
      errors.push(`${prefix} does not require ${rule.fields.join(',')} when ${rule.trigger} exists`);
    }
    const fixtureNode = (rule.path || []).reduce((value, field) => value?.[field], fixtureValue);
    if (fixtureNode && rule.trigger in fixtureNode) {
      for (const field of rule.fields) if (!(field in fixtureNode)) errors.push(`${prefix} fixture missing dependent ${field}`);
    }
    return;
  }

  errors.push(`${prefix} uses unsupported rule kind`);
}

function checkSecurityConstraints({ errors, validator, inventoryMethod, fixture }) {
  const methodName = inventoryMethod.name;
  if (inventoryMethod.input.constraints.includes('reject_trusted_context')) {
    const forged = { ...structuredClone(fixture.input), actor_context: { user_id: 'forged' } };
    if (validator.validateInput(methodName, forged).valid) errors.push(`${methodName} input accepted caller-forged actor_context`);
  }
  if (inventoryMethod.output.constraints.includes('no_runtime_path')) {
    const forged = { ...structuredClone(fixture.output), absolute_path: '/private/runtime' };
    if (validator.validateOutput(methodName, forged).valid) errors.push(`${methodName} output accepted an absolute runtime path`);
  }
  if (inventoryMethod.input.constraints.includes('https_public_network_only')) {
    for (const url of ['file:///etc/passwd', 'http://example.com', 'https://localhost/admin', 'https://127.0.0.1/admin']) {
      const forged = { ...structuredClone(fixture.input), url };
      if (validator.validateInput(methodName, forged).valid) errors.push(`${methodName} input accepted forbidden URL ${url}`);
    }
  }
  if (inventoryMethod.output.constraints.includes('no_internal_ai_routing')) {
    const forged = structuredClone(fixture.output);
    if ('structured_result' in forged || ['ai.chat', 'ai.reason', 'ai.vision'].includes(methodName)) {
      delete forged.text;
      forged.structured_result = { nested: [{ Provider: 'internal' }] };
    } else {
      forged.Provider = 'internal';
    }
    if (validator.validateOutput(methodName, forged).valid) errors.push(`${methodName} output accepted internal AI routing metadata`);
  }
}

export function auditPublicMethodContracts({
  repoRoot = defaultRepoRoot,
  schemaOverrides = new Map(),
  fixtureOverrides = new Map(),
} = {}) {
  const errors = [];
  const contractsDir = path.join(repoRoot, 'docs/contracts/v1');
  const schemaDir = path.join(contractsDir, 'public-method-schemas');
  const inventory = readJson(path.join(schemaDir, 'method-contract-inventory.json'));
  const catalog = readJson(path.join(contractsDir, 'public-capability-methods.json'));
  const fixtureDocument = readJson(path.join(schemaDir, 'method-fixtures.json'));
  const validator = createPublicMethodValidator({ repoRoot, schemaOverrides, fixtureOverrides });
  const inventoryMethods = Array.isArray(inventory.methods) ? inventory.methods : [];
  const inventoryNames = inventoryMethods.map(({ name }) => name);
  const catalogNames = catalog.methods.map(({ name }) => name);
  const fixtureNames = fixtureDocument.methods.map(({ name }) => name);

  const generatorSource = fs.readFileSync(path.join(schemaDir, 'generate.mjs'), 'utf8');
  if (generatorSource.includes('method-contract-inventory')) {
    errors.push('generate.mjs must not read or write the independent method contract inventory');
  }
  if (inventory.generation_source !== 'must_not_import_or_be_generated_from_generate.mjs') {
    errors.push('inventory does not declare its independent generation boundary');
  }
  const semanticReview = inventory.semantic_review;
  const semanticRules = Array.isArray(semanticReview?.rules) ? semanticReview.rules : [];
  const supportedRuleKinds = ['at_least_one', 'exactly_one', 'dependent_required', 'nested_min_properties'];
  if (JSON.stringify(semanticReview?.supported_rule_kinds) !== JSON.stringify(supportedRuleKinds)) {
    errors.push('inventory semantic review does not declare every supported rule kind');
  }
  if (semanticReview?.coverage?.method_source !== 'inventory.methods'
    || JSON.stringify(semanticReview?.coverage?.directions) !== JSON.stringify(['input', 'output'])
    || semanticReview?.coverage?.expected_directions !== inventoryMethods.length * 2) {
    errors.push('inventory semantic review does not cover every method input/output direction');
  }
  if (!Array.isArray(inventory.methods)) errors.push('inventory methods must be an array');
  for (const method of inventory.methods || []) {
    if (typeof method.name !== 'string'
      || !['none', 'risk_gate', 'risk_gate_when_triggered'].includes(method.required_gate)
      || !Array.isArray(method.risk_kinds)
      || !method.input || typeof method.input.required !== 'object' || !Array.isArray(method.input.constraints)
      || !method.output || typeof method.output.required !== 'object' || !Array.isArray(method.output.constraints)) {
      errors.push(`inventory method ${method?.name || '<unknown>'} has an invalid machine-audit shape`);
    }
  }
  for (const [label, names] of [['inventory', inventoryNames], ['catalog', catalogNames], ['fixture', fixtureNames]]) {
    if (names.length !== 35) errors.push(`${label} contains ${names.length} methods instead of 35`);
    if (new Set(names).size !== names.length) errors.push(`${label} contains duplicate method names`);
  }
  if (JSON.stringify(inventoryNames) !== JSON.stringify(catalogNames)) errors.push('inventory and catalog method order/set differ');
  if (JSON.stringify(inventoryNames) !== JSON.stringify(fixtureNames)) errors.push('inventory and fixture method order/set differ');

  const catalogByName = new Map(catalog.methods.map((method) => [method.name, method]));
  const fixtureByName = validator.fixtures;
  let schemaDocumentsChecked = 0;
  let fixtureDocumentsChecked = 0;

  for (const inventoryMethod of inventoryMethods) {
    const catalogMethod = catalogByName.get(inventoryMethod.name);
    const fixture = fixtureByName.get(inventoryMethod.name);
    if (!catalogMethod || !fixture) continue;
    if (catalogMethod.required_gate !== inventoryMethod.required_gate) {
      errors.push(`${inventoryMethod.name} required_gate differs between inventory and catalog`);
    }
    if (JSON.stringify(catalogMethod.risk_kinds) !== JSON.stringify(inventoryMethod.risk_kinds)) {
      errors.push(`${inventoryMethod.name} risk_kinds differ between inventory and catalog`);
    }

    for (const direction of ['input', 'output']) {
      const uri = catalogMethod[`${direction}_schema`];
      const schema = validator.schemaFor(uri);
      schemaDocumentsChecked += 1;
      fixtureDocumentsChecked += 1;
      if (schema.$id !== uri) errors.push(`${inventoryMethod.name} ${direction} schema id differs from catalog`);
      if (schema.type !== 'object' || schema.additionalProperties !== false) {
        errors.push(`${inventoryMethod.name} ${direction} schema is not a closed object`);
      }
      const declaredRequired = new Set(schema.required || []);
      const inventoryRequired = Object.entries(inventoryMethod[direction].required);
      for (const [field, descriptor] of inventoryRequired) {
        if (!declaredRequired.has(field)) errors.push(`${inventoryMethod.name} ${direction} missing required ${field}`);
        if (!descriptorMatches(schema.properties?.[field], descriptor)) {
          errors.push(`${inventoryMethod.name} ${direction} ${field} does not match inventory type ${descriptor}`);
        }
        if (!(field in fixture[direction])) errors.push(`${inventoryMethod.name} ${direction} fixture missing ${field}`);
      }
      const validation = direction === 'input'
        ? validator.validateInput(inventoryMethod.name, fixture.input)
        : validator.validateOutput(inventoryMethod.name, fixture.output);
      if (!validation.valid) errors.push(`${inventoryMethod.name} ${direction} fixture fails generated schema`);

      const directionRules = semanticRules.filter((rule) => rule.method === inventoryMethod.name && rule.direction === direction);
      for (const feature of collectSemanticFeatures(schema)) {
        if (!directionRules.some((rule) => ruleCoversFeature(rule, feature))) {
          errors.push(`${inventoryMethod.name} ${direction} has untracked semantic keyword ${feature.keyword} at ${feature.path || '<root>'}`);
        }
      }
      for (const rule of directionRules) {
        checkSemanticRule({
          errors,
          rule,
          schema,
          fixtureValue: fixture[direction],
          validateFixture: (value) => direction === 'input'
            ? validator.validateInput(inventoryMethod.name, value)
            : validator.validateOutput(inventoryMethod.name, value),
        });
      }
    }
    checkSecurityConstraints({ errors, validator, inventoryMethod, fixture });
  }

  return {
    valid: errors.length === 0,
    errors,
    methods_checked: inventoryMethods.length,
    schema_documents_checked: schemaDocumentsChecked,
    fixture_documents_checked: fixtureDocumentsChecked,
    semantic_directions_reviewed: inventoryMethods.length * 2,
    semantic_rules_checked: semanticRules.length,
  };
}
