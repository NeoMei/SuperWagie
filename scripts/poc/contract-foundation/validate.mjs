#!/usr/bin/env node
// SuperWagie Contract Foundation validator (current baseline: CF-PROTOCOL-002).
// Exit codes: 0 = all checks pass, 1 = verification failure, 2 = environment problem.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { auditPublicMethodContracts } from "./public-method-inventory-validator.mjs";
import { createPublicMethodValidator } from "./public-method-validator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const fixtureId = argValue("--fixture", "CF-PROTOCOL-002");
const resultsPath = argValue("--results-json", null);

const startedAt = new Date().toISOString();
const checks = [];
function check(id, passed, detail) {
  checks.push({ id, passed: !!passed, detail: detail || null });
  console.log((passed ? "PASS" : "FAIL") + "  " + id + (passed ? "" : "  -- " + (detail || "")));
  return passed;
}

const contractsDir = path.join(repoRoot, "docs", "contracts", "v1");
const fixturesDir = path.join(repoRoot, "fixtures", "contract-foundation", fixtureId);

try {
  const schemaFiles = [
    "resource-handle.schema.json",
    "ui-query.schema.json",
    "human-gates.schema.json",
    "envelopes.schema.json",
    "capability-manifest.schema.json",
    "states.schema.json",
    "public-capability-methods.schema.json",
    "viewer-descriptor.schema.json",
    "format-admission-record.schema.json",
    "viewer-chunk-manifest.schema.json",
    "viewer-protocol.schema.json",
    "viewer-security.schema.json",
    "viewer-review.schema.json",
    "viewer-render-artifacts.schema.json",
    "viewer-gate-receipt.schema.json"
  ];
  const schemas = {};
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  // 1. JSON syntax + JSON Schema 2020-12 meta-validation
  for (const f of schemaFiles) {
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(path.join(contractsDir, f), "utf8"));
    } catch (e) {
      check("syntax:" + f, false, String(e));
      continue;
    }
    schemas[f] = schema;
    const metaOk = ajv.validateSchema(schema) === true;
    check("meta2020:" + f, metaOk, metaOk ? null : ajv.errorsText(ajv.errors));
  }

  // 2. Compile every protocol root and per-type branch validators.
  // External schemas must be registered before envelopes.schema.json is compiled.
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  const envelopes = schemas["envelopes.schema.json"];
  if (!envelopes) throw new Error("envelopes.schema.json unavailable");
  const resourceHandle = schemas["resource-handle.schema.json"];
  const uiQuery = schemas["ui-query.schema.json"];
  const humanGates = schemas["human-gates.schema.json"];
  if (!resourceHandle || !uiQuery || !humanGates) throw new Error("solution B protocol schemas unavailable");
  const typeRefs = {
    ClientIntent: envelopes.$id + "#/\u0024defs/ClientIntent",
    AuthorizedCommand: envelopes.$id + "#/\u0024defs/AuthorizedCommand",
    CommandResultEnvelope: envelopes.$id + "#/\u0024defs/CommandResultEnvelope",
    EventEnvelope: envelopes.$id + "#/\u0024defs/EventEnvelope",
    ArtifactRef: envelopes.$id + "#/\u0024defs/ArtifactRef",
    ErrorEnvelope: envelopes.$id + "#/\u0024defs/ErrorEnvelope",
    ResourceHandle: resourceHandle.$id,
    QueryRequest: uiQuery.$id + "#/\u0024defs/QueryRequest",
    QuerySnapshot: uiQuery.$id + "#/\u0024defs/QuerySnapshot",
    SubscriptionOpen: uiQuery.$id + "#/\u0024defs/SubscriptionOpen",
    SubscriptionAccepted: uiQuery.$id + "#/\u0024defs/SubscriptionAccepted",
    ProjectionEvent: uiQuery.$id + "#/\u0024defs/ProjectionEvent",
    ResyncRequired: uiQuery.$id + "#/\u0024defs/ResyncRequired"
  };
  for (const name of [
    "WorkflowGateDecision", "RiskGateDecision", "InstallGateDecision",
    "WorkflowGateReceipt", "RiskGateReceipt", "InstallGateReceipt"
  ]) {
    typeRefs[name] = humanGates.$id + "#/\u0024defs/" + name;
  }
  const viewerDefinitions = {
    "viewer-descriptor.schema.json": ["ViewerDescriptor"],
    "format-admission-record.schema.json": ["FormatAdmissionRecord"],
    "viewer-chunk-manifest.schema.json": ["ViewerChunkManifest"],
    "viewer-protocol.schema.json": ["ViewerOpenCommand", "ViewerDiagnostic", "ViewerStateSnapshot"],
    "viewer-security.schema.json": ["ViewerResourceHandle", "SecretHandle", "FontEnvironment", "OfficeFeatureInventory"],
    "viewer-review.schema.json": ["ViewerAnnotationAnchor", "DiffCapability", "ViewerExportCommand"],
    "viewer-render-artifacts.schema.json": ["PptPageRender"],
    "viewer-gate-receipt.schema.json": ["BenchmarkManifest", "ViewerGateReceipt"]
  };
  const typeNames = Object.keys(typeRefs);
  const branch = {};
  for (const [name, ref] of Object.entries(typeRefs)) branch[name] = ajv.compile({ $ref: ref });
  const viewerBranch = new Map();
  for (const [schemaFile, definitions] of Object.entries(viewerDefinitions)) {
    const schema = schemas[schemaFile];
    if (!schema) throw new Error(schemaFile + " unavailable");
    for (const definition of definitions) {
      viewerBranch.set(`${schemaFile}#${definition}`, ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` }));
    }
  }
  const roots = [
    ajv.getSchema(envelopes.$id), ajv.getSchema(resourceHandle.$id),
    ajv.getSchema(uiQuery.$id), ajv.getSchema(humanGates.$id)
  ];

  const viewerFixturePath = path.join(contractsDir, "viewer-contract-fixtures.json");
  const viewerFixtureDocument = JSON.parse(fs.readFileSync(viewerFixturePath, "utf8"));
  const viewerCases = Array.isArray(viewerFixtureDocument.cases) ? viewerFixtureDocument.cases : [];
  check("viewer-fixtures:present", viewerCases.length > 0, "cases array empty");
  for (const [branchId, validate] of viewerBranch) {
    const cases = viewerCases.filter(caseDef => `${caseDef.schema_file}#${caseDef.definition}` === branchId);
    const validCases = cases.filter(caseDef => caseDef.expect === "valid");
    const invalidCases = cases.filter(caseDef => caseDef.expect === "invalid");
    check(`viewer-fixtures:${branchId}:valid-present`, validCases.length >= 1, "missing valid case");
    check(`viewer-fixtures:${branchId}:invalid-present`, invalidCases.length >= 1, "missing invalid case");
    for (const caseDef of cases) {
      const accepted = validate(caseDef.instance) === true;
      const passed = caseDef.expect === "valid" ? accepted : !accepted;
      check(`viewer-case:${caseDef.case_id}`, passed,
        passed ? null : (accepted ? "invalid fixture accepted" : ajv.errorsText(validate.errors)));
    }
  }
  const formatRecordValidator = viewerBranch.get("format-admission-record.schema.json#FormatAdmissionRecord");
  const admissionLedger = JSON.parse(fs.readFileSync(path.join(contractsDir, "format-admission-ledger.json"), "utf8"));
  const invalidAdmissionRecords = (admissionLedger.records ?? [])
    .filter(record => formatRecordValidator(record) !== true)
    .map(record => record.format_variant_id ?? "unknown");
  check("viewer-ledger:all-records-schema-valid",
    Array.isArray(admissionLedger.records) && admissionLedger.records.length > 0 && invalidAdmissionRecords.length === 0,
    invalidAdmissionRecords.join(","));

  // 3. Error-code catalog consistency
  const catPath = path.join(contractsDir, "error-codes.json");
  const catalog = JSON.parse(fs.readFileSync(catPath, "utf8"));
  const codeEntries = Array.isArray(catalog.codes) ? catalog.codes : [];
  check("catalog:nonempty", codeEntries.length > 0, "codes array empty");
  const ids = codeEntries.map(c => c.code);
  check("catalog:unique", new Set(ids).size === ids.length, "duplicate codes: " + ids.filter((v, i) => ids.indexOf(v) !== i).join(","));
  const codePattern = envelopes.$defs.ErrorEnvelope.properties.error_code.pattern;
  const codeRe = new RegExp(codePattern);
  const badCodes = ids.filter(c => !codeRe.test(c));
  check("catalog:code-pattern", badCodes.length === 0, badCodes.join(","));
  const catEnum = envelopes.$defs.ErrorEnvelope.properties.category.enum;
  const retryEnum = envelopes.$defs.ErrorEnvelope.properties.retryability.enum;
  const badCat = codeEntries.filter(c => !catEnum.includes(c.category)).map(c => c.code);
  const badRetry = codeEntries.filter(c => !retryEnum.includes(c.retryability)).map(c => c.code);
  check("catalog:category-enum", badCat.length === 0, badCat.join(","));
  check("catalog:retryability-enum", badRetry.length === 0, badRetry.join(","));
  const knownCats = new Set(catEnum);
  const uncovered = [...knownCats].filter(c => !codeEntries.some(e => e.category === c));
  check("catalog:category-coverage", uncovered.length === 0, "categories without any code: " + uncovered.join(","));

  // Public method names and their input/output schemas are a resolved,
  // versioned contract. Domain handlers remain outside Contract Foundation.
  const publicCatalogPath = path.join(contractsDir, "public-capability-methods.json");
  const publicCatalog = JSON.parse(fs.readFileSync(publicCatalogPath, "utf8"));
  const publicCatalogSchema = schemas["public-capability-methods.schema.json"];
  const validatePublicCatalog = ajv.getSchema(publicCatalogSchema.$id);
  const publicCatalogValid = validatePublicCatalog(publicCatalog) === true;
  check("public-catalog:schema", publicCatalogValid,
    publicCatalogValid ? null : ajv.errorsText(validatePublicCatalog.errors));
  const publicNames = Array.isArray(publicCatalog.methods)
    ? publicCatalog.methods.map(method => method.name)
    : [];
  check("public-catalog:unique-methods", new Set(publicNames).size === publicNames.length,
    "duplicate methods: " + publicNames.filter((v, i) => publicNames.indexOf(v) !== i).join(","));
  const publicMethodSchemasResolved = publicCatalog.schema_resolution_status === "resolved";
  check("public-catalog:resolution-status-resolved", publicMethodSchemasResolved,
    "schema_resolution_status must be resolved");
  check("public-catalog:method-count", publicCatalog.methods.length === 34,
    "expected 34 methods, got " + publicCatalog.methods.length);
  const publicSchemaUris = publicCatalog.methods.flatMap(method => [method.input_schema, method.output_schema]);
  check("public-catalog:schema-uri-count", publicSchemaUris.length === 68 && new Set(publicSchemaUris).size === 68,
    "expected 68 unique schema URIs, got " + new Set(publicSchemaUris).size);
  const deprecatedRenderPreview = publicCatalog.deprecated_methods?.find(method => method.name === "wps.render_preview");
  check("public-catalog:wps-render-preview-not-active", !publicNames.includes("wps.render_preview"),
    "wps.render_preview remains active");
  check("public-catalog:wps-render-preview-deprecated", deprecatedRenderPreview?.deprecated_on === "2026-09-04"
    && deprecatedRenderPreview?.replacement === "internal_universal_viewer_or_trusted_host_smoke",
    "missing explicit wps.render_preview compatibility record");

  const publicValidator = createPublicMethodValidator({ repoRoot });
  check("public-schema:resolver-count", publicValidator.schemas.size === 68,
    "resolved schemas=" + publicValidator.schemas.size);
  let publicMetaValid = 0;
  let publicMinimalValid = 0;
  let publicNegativeRejected = 0;
  for (const method of publicCatalog.methods) {
    const fixture = publicValidator.fixtures.get(method.name);
    const inputSchema = publicValidator.schemaFor(method.input_schema);
    const outputSchema = publicValidator.schemaFor(method.output_schema);
    const inputMeta = inputSchema.$schema === "https://json-schema.org/draft/2020-12/schema"
      && inputSchema.$id === method.input_schema
      && publicValidator.ajv.validateSchema(inputSchema) === true;
    const outputMeta = outputSchema.$schema === "https://json-schema.org/draft/2020-12/schema"
      && outputSchema.$id === method.output_schema
      && publicValidator.ajv.validateSchema(outputSchema) === true;
    if (inputMeta) publicMetaValid += 1;
    if (outputMeta) publicMetaValid += 1;
    check("public-schema:meta:" + method.name + ":input", inputMeta,
      inputMeta ? null : publicValidator.ajv.errorsText(publicValidator.ajv.errors));
    check("public-schema:meta:" + method.name + ":output", outputMeta,
      outputMeta ? null : publicValidator.ajv.errorsText(publicValidator.ajv.errors));

    const inputResult = fixture ? publicValidator.validateInput(method.name, fixture.input) : { valid: false, errors: [{ message: "fixture missing" }] };
    const outputResult = fixture ? publicValidator.validateOutput(method.name, fixture.output) : { valid: false, errors: [{ message: "fixture missing" }] };
    if (inputResult.valid) publicMinimalValid += 1;
    if (outputResult.valid) publicMinimalValid += 1;
    check("public-schema:minimal:" + method.name + ":input", inputResult.valid, JSON.stringify(inputResult.errors));
    check("public-schema:minimal:" + method.name + ":output", outputResult.valid, JSON.stringify(outputResult.errors));

    const forgedInput = fixture
      ? publicValidator.validateInput(method.name, { ...fixture.input, actor_context: { user_id: "forged" } })
      : { valid: true, errors: [] };
    const forgedOutput = fixture
      ? publicValidator.validateOutput(method.name, { ...fixture.output, provider: "forged" })
      : { valid: true, errors: [] };
    if (!forgedInput.valid) publicNegativeRejected += 1;
    if (!forgedOutput.valid) publicNegativeRejected += 1;
    check("public-schema:negative:" + method.name + ":trusted-context", !forgedInput.valid,
      forgedInput.valid ? "actor_context was accepted" : null);
    check("public-schema:negative:" + method.name + ":output-internal-field", !forgedOutput.valid,
      forgedOutput.valid ? "provider was accepted" : null);
  }
  check("public-schema:all-meta-valid", publicMetaValid === 68, "valid=" + publicMetaValid + "/68");
  check("public-schema:all-minimal-valid", publicMinimalValid === 68, "valid=" + publicMinimalValid + "/68");
  check("public-schema:all-negative-rejected", publicNegativeRejected === 68, "rejected=" + publicNegativeRejected + "/68");

  const inventoryAudit = auditPublicMethodContracts({ repoRoot });
  check("public-inventory:four-way-audit", inventoryAudit.valid,
    inventoryAudit.valid ? null : inventoryAudit.errors.join("; "));
  const workspaceReadDefinition = publicCatalog.methods.find(method => method.name === "workspace.read");
  const placeholderSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: workspaceReadDefinition.input_schema,
    type: "object",
    additionalProperties: false,
    required: ["placeholder"],
    properties: { placeholder: { type: "string" } }
  };
  const placeholderAudit = auditPublicMethodContracts({
    repoRoot,
    schemaOverrides: new Map([[workspaceReadDefinition.input_schema, placeholderSchema]])
  });
  const placeholderMutationRejected = placeholderAudit.valid === false
    && placeholderAudit.errors.some(message => /workspace\.read.*logical_path/.test(message));
  check("public-inventory:placeholder-mutation-rejected", placeholderMutationRejected,
    placeholderMutationRejected ? null : placeholderAudit.errors.join("; "));

  const chatDefinition = publicCatalog.methods.find(method => method.name === "ai.chat");
  const chatSchemaMutation = structuredClone(publicValidator.schemaFor(chatDefinition.output_schema));
  delete chatSchemaMutation.properties.text;
  delete chatSchemaMutation.properties.structured_result;
  delete chatSchemaMutation.anyOf;
  const chatFixtureMutation = structuredClone(publicValidator.fixtures.get("ai.chat"));
  delete chatFixtureMutation.output.text;
  delete chatFixtureMutation.output.structured_result;
  const chatSemanticAudit = auditPublicMethodContracts({
    repoRoot,
    schemaOverrides: new Map([[chatDefinition.output_schema, chatSchemaMutation]]),
    fixtureOverrides: new Map([["ai.chat", chatFixtureMutation]])
  });
  const chatSemanticMutationRejected = chatSemanticAudit.valid === false
    && chatSemanticAudit.errors.some(message => /ai\.chat output.*(?:at_least_one|text.*structured_result)/.test(message));
  check("public-inventory:ai-chat-result-mutation-rejected", chatSemanticMutationRejected,
    chatSemanticMutationRejected ? null : chatSemanticAudit.errors.join("; "));

  const taskUpdateDefinition = publicCatalog.methods.find(method => method.name === "task.update");
  const taskUpdateSchemaMutation = structuredClone(publicValidator.schemaFor(taskUpdateDefinition.input_schema));
  delete taskUpdateSchemaMutation.properties.patch.minProperties;
  const taskUpdateFixtureMutation = structuredClone(publicValidator.fixtures.get("task.update"));
  taskUpdateFixtureMutation.input.patch = {};
  const taskUpdateSemanticAudit = auditPublicMethodContracts({
    repoRoot,
    schemaOverrides: new Map([[taskUpdateDefinition.input_schema, taskUpdateSchemaMutation]]),
    fixtureOverrides: new Map([["task.update", taskUpdateFixtureMutation]])
  });
  const taskUpdateSemanticMutationRejected = taskUpdateSemanticAudit.valid === false
    && taskUpdateSemanticAudit.errors.some(message => /task\.update input.*min_properties/.test(message));
  check("public-inventory:task-update-empty-patch-mutation-rejected", taskUpdateSemanticMutationRejected,
    taskUpdateSemanticMutationRejected ? null : taskUpdateSemanticAudit.errors.join("; "));
  const semanticMutationsRejected = Number(chatSemanticMutationRejected) + Number(taskUpdateSemanticMutationRejected);

  // 4. Fixture cases
  if (!fs.existsSync(fixturesDir)) throw new Error("fixture directory missing: " + fixturesDir);
  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith(".json")).sort();
  check("fixture:files-present", files.length > 0, "no fixture files found");

  function schemaVerdict(envelope) {
    const matched = typeNames.filter(n => branch[n](envelope));
    return { matched, rootValid: roots.some(validate => validate(envelope)) };
  }
  function padEnvelope(caseDef) {
    const e = JSON.parse(JSON.stringify(caseDef.envelope));
    if (caseDef.padding_bytes) e.payload.blob = "x".repeat(caseDef.padding_bytes);
    return e;
  }
  function resourcePolicyOutcome(caseDef) {
    const { handle, request } = caseDef;
    const handleAudience = handle.audience;
    const requestAudience = request.audience;
    const schemaValid = branch.ResourceHandle(handle);
    const issuedAt = Date.parse(handle.issued_at);
    const requestedAt = Date.parse(request.at);
    const expiresAt = Date.parse(handle.expires_at);
    let outcome = "allowed";
    if (!schemaValid) outcome = "invalid-handle";
    else if (request.revoked === true) outcome = "revoked";
    else if (handleAudience.kind !== requestAudience.kind || handleAudience.id !== requestAudience.id) outcome = "audience-mismatch";
    else if (handle.resource_revision !== request.resource_revision) outcome = "revision-mismatch";
    else if (!handle.allowed_operations.includes(request.operation)) outcome = "operation-denied";
    else if (!Number.isFinite(issuedAt) || !Number.isFinite(requestedAt) || requestedAt < issuedAt) outcome = "not-yet-valid";
    else if (!Number.isFinite(expiresAt) || requestedAt >= expiresAt) outcome = "expired";
    else if (request.requested_bytes > handle.size_limit_bytes) outcome = "size-exceeded";
    else if (request.requested_range_bytes > handle.range_limit_bytes) outcome = "range-exceeded";
    else if (handle.one_shot === true && request.one_shot_consumed === true) outcome = "consumed";
    return { outcome, schemaValid };
  }
  function cancelIntentOutcome(caseDef) {
    const envelope = caseDef.envelope;
    const payload = envelope.payload;
    const schemaValid = branch.ClientIntent(envelope);
    const payloadKeys = payload && typeof payload === "object" ? Object.keys(payload) : [];
    const targetRequestId = payload?.request_id;
    const accepted = schemaValid
      && envelope.command_type === "system.request.cancel"
      && payloadKeys.length === 1
      && payloadKeys[0] === "request_id"
      && typeof targetRequestId === "string"
      && targetRequestId.length > 0
      && targetRequestId !== envelope.request_id;
    return { outcome: accepted ? "accepted" : "rejected", schemaValid };
  }
  function projectionStreamOutcome(caseDef) {
    const { snapshot, events } = caseDef;
    const schemaValid = branch.QuerySnapshot(snapshot) && events.every(event => branch.ProjectionEvent(event));
    let outcome = "continuous";
    if (!schemaValid) outcome = "invalid-stream";
    else if (caseDef.core_restarted === true) outcome = "resync_required";
    else if (events.some(event => event.subscription_id !== caseDef.subscription_id)) outcome = "resync_required";
    else if (events.some((event, index) => event.snapshot_revision !== snapshot.snapshot_revision + index + 1)) outcome = "resync_required";
    else if (events.some(event => event.projection_version !== snapshot.projection_version)) outcome = "resync_required";
    else if (JSON.stringify(events.map(event => event.event_cursor)) !== JSON.stringify(caseDef.expected_cursors)) outcome = "resync_required";
    return { outcome, schemaValid };
  }

  for (const f of files) {
    const raw = fs.readFileSync(path.join(fixturesDir, f), "utf8");
    let c;
    try { c = JSON.parse(raw); } catch (e) { check("case:" + f, false, "invalid JSON: " + e); continue; }
    const cid = c.case_id || f;
    if (c.kind === "schema") {
      const v = schemaVerdict(c.envelope);
      if (c.expect === "valid") {
        const exact = c.expect_type ? v.matched.length === 1 && v.matched[0] === c.expect_type : v.matched.length === 1;
        check("case:" + cid, v.rootValid && exact, "matched=[" + v.matched.join(",") + "] rootValid=" + v.rootValid);
      } else {
        check("case:" + cid, v.matched.length === 0 && !v.rootValid, "unexpectedly matched=[" + v.matched.join(",") + "]");
      }
    } else if (c.kind === "event-sequence") {
      const allValid = c.envelopes.every(e => branch.EventEnvelope(e));
      let outcome = "ok";
      const seen = new Set();
      let prev = 0;
      for (const e of c.envelopes) {
        const r = e.aggregate_revision;
        if (seen.has(r)) { outcome = "duplicate"; break; }
        if (seen.size > 0 && r !== prev + 1) { outcome = "gap"; break; }
        seen.add(r);
        prev = r;
      }
      check("case:" + cid, allValid && outcome === c.expect, "outcome=" + outcome + " schemaValid=" + allValid);
    } else if (c.kind === "size-limit") {
      const e = padEnvelope(c);
      const bytes = Buffer.byteLength(JSON.stringify(e), "utf8");
      const outcome = bytes > c.max_bytes ? "over-limit" : "within-limit";
      check("case:" + cid, outcome === c.expect, "bytes=" + bytes + " max=" + c.max_bytes + " outcome=" + outcome);
    } else if (c.kind === "deadline") {
      const a = Date.parse(c.envelope.issued_at);
      const b = Date.parse(c.envelope.deadline_at);
      const outcome = Number.isFinite(a) && Number.isFinite(b) && b > a ? "met" : "violated";
      check("case:" + cid, outcome === c.expect, "outcome=" + outcome);
    } else if (c.kind === "request-log") {
      const allValid = c.envelopes.every(e => branch.ClientIntent(e));
      const rids = c.envelopes.map(e => e.request_id);
      const outcome = new Set(rids).size === rids.length ? "unique" : "duplicate";
      check("case:" + cid, allValid && outcome === c.expect, "outcome=" + outcome + " schemaValid=" + allValid);
    } else if (c.kind === "resource-policy") {
      const { outcome, schemaValid } = resourcePolicyOutcome(c);
      const schemaExpectationMet = c.expect === "invalid-handle" ? !schemaValid : schemaValid;
      check("case:" + cid, schemaExpectationMet && outcome === c.expect, "outcome=" + outcome + " schemaValid=" + schemaValid);
    } else if (c.kind === "projection-stream") {
      const { outcome, schemaValid } = projectionStreamOutcome(c);
      const schemaExpectationMet = c.expect === "invalid-stream" ? !schemaValid : schemaValid;
      check("case:" + cid, schemaExpectationMet && outcome === c.expect, "outcome=" + outcome + " schemaValid=" + schemaValid);
    } else if (c.kind === "cancel-intent") {
      const { outcome, schemaValid } = cancelIntentOutcome(c);
      check("case:" + cid, schemaValid && outcome === c.expect, "outcome=" + outcome + " schemaValid=" + schemaValid);
    } else {
      check("case:" + cid, false, "unknown kind: " + c.kind);
    }
  }

  // 5. Independent TypeScript, Python, and Rust consumers must reach the
  // same observation for every fixture. The parity runner uses only the
  // checked-in schemas, fixtures, and locked tool dependencies.
  const nodeChecksPassed = checks.every(x => x.passed);
  const parityRunner = path.join(here, "consumer-parity.mjs");
  const parityCompleted = spawnSync(process.execPath, [
    parityRunner, "--repo-root", repoRoot, "--fixture", fixtureId
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (parityCompleted.error) throw parityCompleted.error;
  if (parityCompleted.status !== 0 && parityCompleted.status !== 1) {
    throw new Error("consumer parity environment failure: " + (parityCompleted.stderr || parityCompleted.stdout));
  }
  let parityReport;
  try {
    parityReport = JSON.parse(parityCompleted.stdout);
  } catch (error) {
    throw new Error("consumer parity emitted invalid JSON: " + error);
  }
  const parityPassed = parityCompleted.status === 0 && parityReport.pass === true;
  check(
    "consumer-parity:typescript-python-rust",
    parityPassed,
    parityPassed ? null : JSON.stringify(parityReport.failures ?? [])
  );

  const paritySerialized = JSON.stringify(parityReport, null, 2) + "\n";
  const parityEvidence = {
    artifact: "artifacts/consumer-parity.json",
    sha256: "sha256:" + createHash("sha256").update(paritySerialized).digest("hex"),
    summary: parityReport.summary
  };
  if (resultsPath) {
    const artifactPath = path.join(path.dirname(resultsPath), parityEvidence.artifact);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, paritySerialized);
  }

  // 6. Results
  const finishedAt = new Date().toISOString();
  const failed = checks.filter(x => !x.passed);
  const consumerStatus = name => parityReport.consumers?.find(entry => entry.consumer === name)?.pass === true
    ? "passed"
    : "failed";
  const results = {
    gate: "contract-foundation",
    fixture: fixtureId,
    started_at: startedAt,
    finished_at: finishedAt,
    thresholds: { all_checks_pass: true },
    pass: failed.length === 0,
    decision_hint: failed.length === 0 ? "GO" : "NO_GO",
    limitation: null,
    consumer_parity: {
      node_ajv: nodeChecksPassed ? "passed" : "failed",
      rust: consumerStatus("rust"),
      typescript: consumerStatus("typescript"),
      python: consumerStatus("python"),
      public_method_schemas: publicMethodSchemasResolved && publicMinimalValid === 68 && publicNegativeRejected === 68
        ? "resolved"
        : "failed"
    },
    public_method_schemas: {
      catalog_methods: publicCatalog.methods.length,
      resolved_schemas: publicValidator.schemas.size,
      meta_valid_schemas: publicMetaValid,
      valid_minimal_fixtures: publicMinimalValid,
      rejected_negative_fixtures: publicNegativeRejected,
      inventory_methods: inventoryAudit.methods_checked,
      inventory_schema_documents: inventoryAudit.schema_documents_checked,
      inventory_fixture_documents: inventoryAudit.fixture_documents_checked,
      four_way_inventory_valid: inventoryAudit.valid,
      placeholder_mutation_rejected: placeholderMutationRejected,
      semantic_directions_reviewed: inventoryAudit.semantic_directions_reviewed,
      semantic_rules_checked: inventoryAudit.semantic_rules_checked,
      semantic_mutations_rejected: semanticMutationsRejected
    },
    consumer_parity_evidence: parityEvidence,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks
  };
  const summaryLine = "SUMMARY total=" + results.summary.total + " passed=" + results.summary.passed + " failed=" + results.summary.failed;
  console.log(summaryLine);
  if (resultsPath) {
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
  }
  process.exit(results.pass ? 0 : 1);
} catch (e) {
  console.error("ENV-ERROR " + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
}
