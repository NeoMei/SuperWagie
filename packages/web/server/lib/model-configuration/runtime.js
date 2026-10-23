import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { MODEL_PRESETS, MODEL_PURPOSES, MODEL_PROBE_PROTOCOLS, PROTOCOLS, PURPOSE_IDS } from './catalog.js';
import { testModelBinding } from './adapters.js';
import { createCredentialReader, credentialDestinationAllowed, credentialSourceSchema } from './credentials.js';

export class ModelConfigurationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'ModelConfigurationError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status) => { throw new ModelConfigurationError(code, status); };
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const endpoint = z.string().trim().min(1).max(2048).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) context.addIssue({ code: 'custom', message: 'Invalid endpoint' });
  } catch { context.addIssue({ code: 'custom', message: 'Invalid endpoint' }); }
}).transform((value) => value.replace(/\/+$/, ''));
const optionalText = z.string().trim().min(1).max(200).optional();
const parametersSchema = z.object({
  dimensions: z.number().int().min(1).max(65536).optional(),
  voice: z.string().trim().min(1).max(200).optional(),
  language: z.string().trim().min(1).max(50).optional(),
  workspaceId: optionalText,
  region: optionalText,
}).strict();
const connectionFields = {
  id: identifier, name: z.string().trim().min(1).max(120), providerId: identifier,
  protocol: z.enum(PROTOCOLS), baseUrl: endpoint, region: optionalText, workspaceId: optionalText,
};
const exclusiveCredential = (value) => !(value.apiKey && value.credentialSource);
const storedConnectionSchema = z.object({ ...connectionFields, apiKey: z.string().min(1).max(8192).optional(), credentialSource: credentialSourceSchema.optional() }).strict().refine(exclusiveCredential);
const connectionInputSchema = z.object({
  ...connectionFields, id: identifier.optional(), apiKey: z.string().trim().min(1).max(8192).optional(), credentialSource: credentialSourceSchema.optional(),
}).strict().refine(exclusiveCredential);
const verificationSchema = z.object({
  status: z.enum(['untested', 'verified', 'failed']), testedAt: z.string().datetime().optional(), errorCode: z.string().optional(),
  credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const bindingFields = {
  connectionId: identifier, presetId: identifier.optional(), model: z.string().trim().min(1).max(200), parameters: parametersSchema,
};
const bindingInputSchema = z.object(bindingFields).strict();
const storedBindingSchema = z.object({ purpose: z.enum(PURPOSE_IDS), ...bindingFields, verification: verificationSchema }).strict();
const stateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  connections: z.array(storedConnectionSchema).max(100), bindings: z.array(storedBindingSchema).max(PURPOSE_IDS.length),
}).strict();
const revisionSchema = z.number().int().nonnegative();
const connectionMutationSchema = z.object({ revision: revisionSchema, connection: connectionInputSchema }).strict();
const bindingMutationSchema = z.object({ revision: revisionSchema, binding: bindingInputSchema.nullable() }).strict();
const revisionInputSchema = z.object({ revision: revisionSchema }).strict();
const connectionProbeSchema = z.object({
  revision: revisionSchema, purpose: z.enum(PURPOSE_IDS), model: bindingFields.model,
  presetId: bindingFields.presetId, parameters: parametersSchema,
}).strict();
const probeErrorCodeSchema = z.string().regex(/^model_configuration_(?:provider_http_[1-5]\d{2}|provider_unreachable|provider_rejected|invalid_provider_response|dimension_mismatch|credential_missing|invalid_input|unsupported_protocol)$/);
const parseInput = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail('model_configuration_invalid_input', 400);
  return parsed.data;
};
const emptyState = () => ({ version: 1, revision: 0, connections: [], bindings: [] });
const assertIntegrity = (state) => {
  const connections = new Set(state.connections.map((entry) => entry.id));
  if (connections.size !== state.connections.length || new Set(state.bindings.map((entry) => entry.purpose)).size !== state.bindings.length) fail('model_configuration_malformed', 500);
  for (const binding of state.bindings) {
    if (!connections.has(binding.connectionId)) fail('model_configuration_malformed', 500);
    try { checkPreset(binding, state.connections.find((entry) => entry.id === binding.connectionId)); }
    catch { fail('model_configuration_malformed', 500); }
  }
};
const checkPreset = (binding, connection) => {
  if (!binding.presetId) return;
  const preset = MODEL_PRESETS.find((entry) => entry.id === binding.presetId);
  if (!preset || !preset.purposes.includes(binding.purpose) || preset.providerId !== connection.providerId || preset.protocol !== connection.protocol || preset.model !== binding.model) fail('model_configuration_incompatible_preset', 400);
};
const resolved = (state, purpose) => {
  const binding = state.bindings.find((entry) => entry.purpose === purpose);
  if (!binding) return null;
  const connection = state.connections.find((entry) => entry.id === binding.connectionId);
  return {
    purpose, connectionId: connection.id, providerId: connection.providerId, protocol: connection.protocol,
    baseUrl: connection.baseUrl, model: binding.model, apiKey: connection.apiKey,
    parameters: { region: connection.region, workspaceId: connection.workspaceId, ...binding.parameters },
    revision: state.revision,
  };
};
const isLoopback = (baseUrl) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname.toLowerCase());
const credentialFingerprint = (source, apiKey) => createHash('sha256').update(JSON.stringify({ source, apiKey })).digest('hex');

/** Server-only state. Each operation reads fresh state; callers must not cache resolved keys. */
export const createModelConfigurationRuntime = ({ dataDir, enterpriseOptions, fetchImpl = fetch, prepareBindingChange, readOpenCodeCredentials, readOpenCodeProviderMetadata } = {}) => {
  if (!dataDir) throw new Error('Model configuration needs a data directory');
  const filePath = path.join(dataDir, 'model-configuration.json');
  let mutationQueue = Promise.resolve();
  const enterpriseMode = () => isEnterpriseMode(enterpriseOptions);
  const guardEntry = () => { if (enterpriseMode()) fail('enterprise_mode', 403); };
  const guardEgress = (binding) => { if (enterpriseMode() && !isLoopback(binding.baseUrl)) fail('enterprise_mode', 403); };
  const readCredentials = createCredentialReader({ readOpenCodeCredentials, readOpenCodeProviderMetadata });
  const referenceKey = (connection, snapshot) => {
    if (snapshot.status !== 'available') return fail('model_configuration_credential_unavailable', 503);
    if (!credentialDestinationAllowed(connection, snapshot.metadata)) return fail('model_configuration_credential_destination_denied', 403);
    const credential = snapshot.credentials[connection.credentialSource.providerId];
    if (credential?.type !== 'api') return fail('model_configuration_credential_missing', 409);
    return credential.key;
  };
  const resolveStateBinding = async (state, purpose, { allowUnavailable = false } = {}) => {
    const value = resolved(state, purpose);
    if (!value) return null;
    const connection = state.connections.find((entry) => entry.id === value.connectionId);
    if (!connection.credentialSource) return value;
    const snapshot = await readCredentials();
    try { return { ...value, apiKey: referenceKey(connection, snapshot) }; }
    catch (error) { if (!allowUnavailable) throw error; return value; }
  };
  const readState = async () => {
    let text;
    try { text = await fs.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      return fail('model_configuration_unreadable', 500);
    }
    let raw;
    try { raw = JSON.parse(text); } catch { return fail('model_configuration_malformed', 500); }
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) return fail('model_configuration_malformed', 500);
    assertIntegrity(parsed.data);
    return parsed.data;
  };
  const publicState = async (state) => {
    const snapshot = await readCredentials();
    const bindings = state.bindings.map((binding) => {
      const { credentialFingerprint: fingerprint, ...verification } = binding.verification;
      const connection = state.connections.find((entry) => entry.id === binding.connectionId);
      if (!connection.credentialSource || verification.status === 'untested') return { ...binding, verification };
      const credential = snapshot.credentials[connection.credentialSource.providerId];
      const current = snapshot.status === 'available' && credential?.type === 'api' && credentialDestinationAllowed(connection, snapshot.metadata)
        && fingerprint === credentialFingerprint(connection.credentialSource, credential.key);
      return { ...binding, verification: current ? verification : { status: 'untested' } };
    });
    return {
      version: state.version, revision: state.revision, enterpriseMode: enterpriseMode(), purposes: MODEL_PURPOSES,
      presets: MODEL_PRESETS, connections: state.connections.map(({ apiKey, ...connection }) => ({
        ...connection, hasApiKey: connection.credentialSource
          ? snapshot.status === 'available' && snapshot.credentials[connection.credentialSource.providerId]?.type === 'api' && credentialDestinationAllowed(connection, snapshot.metadata)
          : Boolean(apiKey),
      })),
      credentialSources: { status: snapshot.status, sources: snapshot.sources }, bindings,
    };
  };
  const writeState = async (state) => {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
    } catch {
      return fail('model_configuration_write_failed', 500);
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
    }
  };
  const withLock = async (action) => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await fs.open(`${filePath}.lock`, 'wx', 0o600); }
    catch (error) { return fail(error.code === 'EEXIST' ? 'model_configuration_busy' : 'model_configuration_write_failed', 409); }
    try { return await action(); }
    finally { await lock.close(); await fs.unlink(`${filePath}.lock`).catch(() => {}); }
  };
  const mutate = (revision, change) => {
    const result = mutationQueue.then(() => withLock(async () => {
      const state = await readState();
      if (state.revision !== revision) return fail('model_configuration_revision_conflict', 409);
      const next = await change(state);
      next.revision += 1;
      const validated = parseInput(stateSchema, next);
      assertIntegrity(validated);
      await writeState(validated);
      return publicState(validated);
    }));
    mutationQueue = result.catch(() => {});
    return result;
  };
  const prepareChanges = async (previous, next, purposes) => {
    if (!prepareBindingChange) return;
    for (const purpose of purposes) {
      try { await prepareBindingChange(purpose, await resolveStateBinding(next, purpose), await resolveStateBinding(previous, purpose, { allowUnavailable: true })); }
      catch (error) {
        if (error.code === 'model_configuration_embedding_rebuild_required') fail(error.code, 409);
        if (error.code === 'model_configuration_knowledge_not_ready') fail(error.code, 503);
        if (error.code === 'model_configuration_ocr_unavailable') fail(error.code, 503);
        if (error.code === 'model_configuration_unsupported_protocol') fail(error.code, 501);
        throw error;
      }
    }
  };
  const getPublicConfiguration = async () => publicState(await readState());
  const saveConnection = async (input) => {
    guardEntry();
    const { revision, connection } = parseInput(connectionMutationSchema, input);
    return mutate(revision, async (state) => {
      guardEntry();
      const id = connection.id ?? randomUUID();
      const previous = state.connections.find((entry) => entry.id === id);
      if (connection.id && !previous) return fail('model_configuration_connection_missing', 404);
      const destinationChanged = previous && (previous.providerId !== connection.providerId || previous.protocol !== connection.protocol || previous.baseUrl !== connection.baseUrl || previous.workspaceId !== connection.workspaceId || previous.region !== connection.region);
      if (destinationChanged && previous.apiKey && !connection.apiKey && !connection.credentialSource) return fail('model_configuration_replacement_key_required', 400);
      const credentialSource = connection.credentialSource ?? (connection.apiKey ? undefined : previous?.credentialSource);
      const nextConnection = credentialSource
        ? { ...connection, id, credentialSource }
        : { ...connection, id, apiKey: connection.apiKey ?? previous?.apiKey };
      if (credentialSource) referenceKey(nextConnection, await readCredentials());
      const next = structuredClone(state);
      next.connections = [...next.connections.filter((entry) => entry.id !== id), nextConnection];
      const affected = next.bindings.filter((entry) => entry.connectionId === id);
      for (const binding of affected) {
        checkPreset(binding, nextConnection);
        binding.verification = { status: 'untested' };
      }
      await prepareChanges(state, next, affected.map((entry) => entry.purpose));
      return next;
    });
  };
  const removeConnection = async (id, input) => {
    const { revision } = parseInput(revisionInputSchema, input);
    parseInput(identifier, id);
    return mutate(revision, async (state) => {
      if (!state.connections.some((entry) => entry.id === id)) return fail('model_configuration_connection_missing', 404);
      const affected = state.bindings.filter((entry) => entry.connectionId === id);
      if (affected.length) return fail('model_configuration_connection_in_use', 409);
      return { ...state, connections: state.connections.filter((entry) => entry.id !== id) };
    });
  };
  const saveBinding = async (purpose, input) => {
    parseInput(z.enum(PURPOSE_IDS), purpose);
    const { revision, binding } = parseInput(bindingMutationSchema, input);
    const purposeDefinition = MODEL_PURPOSES.find((entry) => entry.id === purpose);
    if (purposeDefinition.status === 'native') return fail('model_configuration_native_purpose', 400);
    return mutate(revision, async (state) => {
      if (binding) {
        const connection = state.connections.find((entry) => entry.id === binding.connectionId);
        if (!connection) return fail('model_configuration_connection_missing', 404);
        checkPreset({ ...binding, purpose }, connection);
      }
      const next = { ...state, bindings: state.bindings.filter((entry) => entry.purpose !== purpose) };
      if (binding) next.bindings.push({ ...binding, purpose, verification: { status: 'untested' } });
      await prepareChanges(state, next, [purpose]);
      return next;
    });
  };
  const resolveBinding = async (purpose, { supportedProtocols } = {}) => {
    parseInput(z.enum(PURPOSE_IDS), purpose);
    const state = await readState();
    const binding = state.bindings.find((entry) => entry.purpose === purpose);
    if (!binding) return null;
    if (MODEL_PURPOSES.find((entry) => entry.id === purpose).status !== 'available') return fail('model_configuration_not_connected', 501);
    const preset = MODEL_PRESETS.find((entry) => entry.id === binding.presetId);
    if (preset && preset.status !== 'compatible') return fail('model_configuration_unsupported_protocol', 501);
    guardEgress(resolved(state, purpose));
    const value = await resolveStateBinding(state, purpose);
    if (supportedProtocols && !supportedProtocols.includes(value.protocol)) return fail('model_configuration_unsupported_protocol', 501);
    return value;
  };
  const testBinding = async (purpose, input) => {
    const { revision } = parseInput(revisionInputSchema, input);
    const before = await readState();
    if (before.revision !== revision) return fail('model_configuration_revision_conflict', 409);
    const binding = await resolveBinding(purpose);
    if (!binding) return fail('model_configuration_binding_missing', 404);
    if (!MODEL_PROBE_PROTOCOLS[purpose]?.includes(binding.protocol)) return fail('model_configuration_probe_unavailable', 501);
    let verification;
    try {
      await testModelBinding(binding, { fetchImpl });
      verification = { status: 'verified', testedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ModelConfigurationError) throw error;
      verification = { status: 'failed', testedAt: new Date().toISOString(), errorCode: error.code ?? 'model_configuration_test_failed' };
    }
    const connection = before.connections.find((entry) => entry.id === binding.connectionId);
    if (connection.credentialSource) verification.credentialFingerprint = credentialFingerprint(connection.credentialSource, binding.apiKey);
    return mutate(revision, async (state) => {
      guardEgress(binding);
      if (connection.credentialSource) {
        const currentKey = referenceKey(connection, await readCredentials());
        if (verification.credentialFingerprint !== credentialFingerprint(connection.credentialSource, currentKey)) return fail('model_configuration_credential_changed', 409);
      }
      return { ...state, bindings: state.bindings.map((entry) => entry.purpose === purpose ? { ...entry, verification } : entry) };
    });
  };
  const testConnection = async (id, input) => {
    parseInput(identifier, id);
    const { revision, purpose, ...model } = parseInput(connectionProbeSchema, input);
    const before = await readState();
    if (before.revision !== revision) return fail('model_configuration_revision_conflict', 409);
    const connection = before.connections.find((entry) => entry.id === id);
    if (!connection) return fail('model_configuration_connection_missing', 404);
    if (MODEL_PURPOSES.find((entry) => entry.id === purpose).status !== 'available') return fail('model_configuration_not_connected', 501);
    const candidate = { ...model, purpose, connectionId: id };
    checkPreset(candidate, connection);
    const preset = MODEL_PRESETS.find((entry) => entry.id === candidate.presetId);
    if (preset && preset.status !== 'compatible') return fail('model_configuration_unsupported_protocol', 501);
    if (!MODEL_PROBE_PROTOCOLS[purpose]?.includes(connection.protocol)) return fail('model_configuration_probe_unavailable', 501);
    const probeState = { ...before, bindings: [candidate] };
    guardEgress(resolved(probeState, purpose));
    const binding = await resolveStateBinding(probeState, purpose);
    let result;
    try {
      await testModelBinding(binding, { fetchImpl });
      result = { status: 'verified', testedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ModelConfigurationError) throw error;
      const parsedCode = probeErrorCodeSchema.safeParse(error.code);
      result = { status: 'failed', testedAt: new Date().toISOString(), errorCode: parsedCode.success ? parsedCode.data : 'model_configuration_test_failed' };
    }
    // Keep the final checks atomic with configuration writes without persisting
    // a binding or turning a connection probe into purpose verification.
    return withLock(async () => {
      const current = await readState();
      if (current.revision !== revision) return fail('model_configuration_revision_conflict', 409);
      if (connection.credentialSource) {
        const currentKey = referenceKey(connection, await readCredentials());
        if (credentialFingerprint(connection.credentialSource, binding.apiKey) !== credentialFingerprint(connection.credentialSource, currentKey)) return fail('model_configuration_credential_changed', 409);
      }
      guardEgress(binding);
      return result;
    });
  };
  return { getPublicConfiguration, saveConnection, removeConnection, saveBinding, testBinding, testConnection, resolveBinding };
};
