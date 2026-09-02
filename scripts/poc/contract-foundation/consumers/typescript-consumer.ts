#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

type JsonObject = Record<string, unknown>;
type Observation = Record<string, unknown>;
type CaseResult = { case_id: string; kind: string; passed: boolean; observed: Observation };

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

const repo = arg('--repo-root');
const fixture = arg('--fixture');
if (!path.isAbsolute(repo) || !/^CF-PROTOCOL-[0-9]{3}$/.test(fixture)) {
  console.error('usage: typescript-consumer.ts --repo-root ABSOLUTE --fixture CF-PROTOCOL-NNN');
  process.exit(2);
}

const contracts = path.join(repo, 'docs/contracts/v1');
const fixtures = path.join(repo, 'fixtures/contract-foundation', fixture);
const schemaFiles = [
  'resource-handle.schema.json',
  'ui-query.schema.json',
  'human-gates.schema.json',
  'envelopes.schema.json',
];

function readJson(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
}

function compactBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

try {
  const schemas = Object.fromEntries(schemaFiles.map((file) => [file, readJson(path.join(contracts, file))]));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);

  const envelopesId = schemas['envelopes.schema.json'].$id as string;
  const resourceId = schemas['resource-handle.schema.json'].$id as string;
  const queryId = schemas['ui-query.schema.json'].$id as string;
  const gatesId = schemas['human-gates.schema.json'].$id as string;
  const refs: Record<string, string> = {
    ClientIntent: `${envelopesId}#/$defs/ClientIntent`,
    AuthorizedCommand: `${envelopesId}#/$defs/AuthorizedCommand`,
    CommandResultEnvelope: `${envelopesId}#/$defs/CommandResultEnvelope`,
    EventEnvelope: `${envelopesId}#/$defs/EventEnvelope`,
    ArtifactRef: `${envelopesId}#/$defs/ArtifactRef`,
    ErrorEnvelope: `${envelopesId}#/$defs/ErrorEnvelope`,
    ResourceHandle: resourceId,
    QueryRequest: `${queryId}#/$defs/QueryRequest`,
    QuerySnapshot: `${queryId}#/$defs/QuerySnapshot`,
    SubscriptionOpen: `${queryId}#/$defs/SubscriptionOpen`,
    SubscriptionAccepted: `${queryId}#/$defs/SubscriptionAccepted`,
    ProjectionEvent: `${queryId}#/$defs/ProjectionEvent`,
    ResyncRequired: `${queryId}#/$defs/ResyncRequired`,
    WorkflowGateDecision: `${gatesId}#/$defs/WorkflowGateDecision`,
    RiskGateDecision: `${gatesId}#/$defs/RiskGateDecision`,
    InstallGateDecision: `${gatesId}#/$defs/InstallGateDecision`,
    WorkflowGateReceipt: `${gatesId}#/$defs/WorkflowGateReceipt`,
    RiskGateReceipt: `${gatesId}#/$defs/RiskGateReceipt`,
    InstallGateReceipt: `${gatesId}#/$defs/InstallGateReceipt`,
  };
  const branches = Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, ajv.compile({ $ref: ref })]));
  const roots = Object.values(schemas).map((schema) => ajv.getSchema(schema.$id as string)!);

  function schemaObservation(envelope: unknown): Observation {
    const matched = Object.entries(branches).filter(([, validate]) => validate(envelope)).map(([name]) => name);
    return { matched, root_valid: roots.some((validate) => validate(envelope)) };
  }

  function resourcePolicyObservation(definition: JsonObject): Observation {
    const handle = definition.handle as JsonObject;
    const request = definition.request as JsonObject;
    const handleAudience = handle.audience as JsonObject;
    const requestAudience = request.audience as JsonObject;
    const schemaValid = branches.ResourceHandle(handle);
    let outcome = 'allowed';
    const issuedAt = Date.parse(String(handle.issued_at));
    const requestedAt = Date.parse(String(request.at));
    const expiresAt = Date.parse(String(handle.expires_at));
    if (!schemaValid) outcome = 'invalid-handle';
    else if (request.revoked === true) outcome = 'revoked';
    else if (handleAudience.kind !== requestAudience.kind || handleAudience.id !== requestAudience.id) outcome = 'audience-mismatch';
    else if (handle.resource_revision !== request.resource_revision) outcome = 'revision-mismatch';
    else if (!(handle.allowed_operations as unknown[]).includes(request.operation)) outcome = 'operation-denied';
    else if (!Number.isFinite(requestedAt) || !Number.isFinite(issuedAt) || requestedAt < issuedAt) outcome = 'not-yet-valid';
    else if (!Number.isFinite(expiresAt) || requestedAt >= expiresAt) outcome = 'expired';
    else if (Number(request.requested_bytes) > Number(handle.size_limit_bytes)) outcome = 'size-exceeded';
    else if (Number(request.requested_range_bytes) > Number(handle.range_limit_bytes)) outcome = 'range-exceeded';
    else if (handle.one_shot === true && request.one_shot_consumed === true) outcome = 'consumed';
    return { outcome, schema_valid: schemaValid };
  }

  function cancelIntentObservation(definition: JsonObject): Observation {
    const envelope = definition.envelope as JsonObject;
    const payload = envelope.payload as JsonObject;
    const schemaValid = branches.ClientIntent(envelope);
    const payloadKeys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
    const targetRequestId = payload?.request_id;
    const accepted = schemaValid
      && envelope.command_type === 'system.request.cancel'
      && payloadKeys.length === 1
      && payloadKeys[0] === 'request_id'
      && typeof targetRequestId === 'string'
      && targetRequestId.length > 0
      && targetRequestId !== envelope.request_id;
    return { outcome: accepted ? 'accepted' : 'rejected', schema_valid: schemaValid };
  }

  function projectionStreamObservation(definition: JsonObject): Observation {
    const snapshot = definition.snapshot as JsonObject;
    const events = definition.events as JsonObject[];
    const schemaValid = branches.QuerySnapshot(snapshot)
      && events.every((event) => branches.ProjectionEvent(event));
    let outcome = 'continuous';
    if (!schemaValid) outcome = 'invalid-stream';
    else if (definition.core_restarted === true) outcome = 'resync_required';
    else if (events.some((event) => event.subscription_id !== definition.subscription_id)) outcome = 'resync_required';
    else if (events.some((event, index) => Number(event.snapshot_revision) !== Number(snapshot.snapshot_revision) + index + 1)) outcome = 'resync_required';
    else if (events.some((event) => event.projection_version !== snapshot.projection_version)) outcome = 'resync_required';
    else {
      const actualCursors = events.map((event) => event.event_cursor);
      if (JSON.stringify(actualCursors) !== JSON.stringify(definition.expected_cursors)) outcome = 'resync_required';
    }
    return { outcome, schema_valid: schemaValid };
  }

  const files = fs.readdirSync(fixtures).filter((file) => file.endsWith('.json')).sort();
  const cases: CaseResult[] = [];
  for (const file of files) {
    const definition = readJson(path.join(fixtures, file));
    const caseId = String(definition.case_id ?? file);
    const kind = String(definition.kind ?? '');
    let observed: Observation;
    let passed = false;
    if (kind === 'schema') {
      observed = schemaObservation(definition.envelope);
      const matched = observed.matched as string[];
      const valid = observed.root_valid === true && matched.length === 1;
      passed = definition.expect === 'valid'
        ? valid && (!definition.expect_type || matched[0] === definition.expect_type)
        : observed.root_valid === false && matched.length === 0;
    } else if (kind === 'size-limit') {
      const envelope = structuredClone(definition.envelope) as { payload: Record<string, unknown> };
      if (definition.padding_bytes) envelope.payload.blob = 'x'.repeat(Number(definition.padding_bytes));
      const bytes = compactBytes(envelope);
      const maxBytes = Number(definition.max_bytes);
      const outcome = bytes > maxBytes ? 'over-limit' : 'within-limit';
      observed = { outcome, bytes, max_bytes: maxBytes };
      passed = outcome === definition.expect;
    } else if (kind === 'request-log') {
      const envelopes = definition.envelopes as unknown[];
      const schemaValid = envelopes.every((envelope) => branches.ClientIntent(envelope));
      const ids = envelopes.map((envelope) => String((envelope as JsonObject).request_id));
      const outcome = new Set(ids).size === ids.length ? 'unique' : 'duplicate';
      observed = { outcome, schema_valid: schemaValid };
      passed = schemaValid && outcome === definition.expect;
    } else if (kind === 'event-sequence') {
      const envelopes = definition.envelopes as JsonObject[];
      const schemaValid = envelopes.every((envelope) => branches.EventEnvelope(envelope));
      const seen = new Set<number>();
      let previous = 0;
      let outcome = 'ok';
      for (const envelope of envelopes) {
        const revision = Number(envelope.aggregate_revision);
        if (seen.has(revision)) { outcome = 'duplicate'; break; }
        if (seen.size > 0 && revision !== previous + 1) { outcome = 'gap'; break; }
        seen.add(revision);
        previous = revision;
      }
      observed = { outcome, schema_valid: schemaValid };
      passed = schemaValid && outcome === definition.expect;
    } else if (kind === 'deadline') {
      const envelope = definition.envelope as JsonObject;
      const issued = Date.parse(String(envelope.issued_at));
      const deadline = Date.parse(String(envelope.deadline_at));
      const outcome = Number.isFinite(issued) && Number.isFinite(deadline) && deadline > issued ? 'met' : 'violated';
      observed = { outcome };
      passed = outcome === definition.expect;
    } else if (kind === 'resource-policy') {
      observed = resourcePolicyObservation(definition);
      passed = observed.outcome === definition.expect
        && (definition.expect === 'invalid-handle' ? observed.schema_valid === false : observed.schema_valid === true);
    } else if (kind === 'projection-stream') {
      observed = projectionStreamObservation(definition);
      passed = observed.outcome === definition.expect
        && (definition.expect === 'invalid-stream' ? observed.schema_valid === false : observed.schema_valid === true);
    } else if (kind === 'cancel-intent') {
      observed = cancelIntentObservation(definition);
      passed = observed.schema_valid === true && observed.outcome === definition.expect;
    } else {
      observed = { error: 'unknown-kind' };
    }
    cases.push({ case_id: caseId, kind, passed, observed });
  }

  const report = {
    schema_id: 'superwagie.contract-consumer-result.v1', schema_version: 1,
    consumer: 'typescript', fixture,
    pass: cases.every(({ passed }) => passed), cases,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.pass ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(2);
}
