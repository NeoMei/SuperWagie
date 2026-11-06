import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isIntegrationNotFoundError, isModelNotFoundError, isProviderNotFoundError, isProviderRequestError, isUnsupportedModelError } from '@opencode/client';
import { z } from 'zod';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { readOpenCodeCredentials as readNativeCredentials } from '../opencode/auth.js';
import { readSectionEntry, toProviderEntity } from '../opencode/config-v2.js';
import { upsertProviderConfig as writeProviderConfig, validateCustomProviderConfig } from '../opencode/providers.js';
import { readConfigLayers } from '../opencode/shared.js';
import { flattenPreferences, parsePreferencesDocument } from '../opencode/settings-files.js';
import { getSmallModelClient } from '../small-model/client.js';
import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';

const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }); };
const UNAVAILABLE = 'model_configuration_account_provider_unavailable';
const CONFLICT = 'model_configuration_account_provider_conflict';
const INVALID = 'model_configuration_account_provider_invalid';
const PROBE_FAILED = 'model_configuration_account_probe_failed';
const PROBE_UNKNOWN = 'model_configuration_account_probe_unknown';
const UNCONFIGURED = 'model_configuration_account_model_unconfigured';
const READY_DELAYS_MS = [250, 500, 1_000, 2_000];
const modelIdentifier = z.string().trim().min(1).max(256).refine((id) => !['__proto__', 'prototype', 'constructor'].includes(id));
const inputSchema = z.object({
  providerId: z.string().regex(/^superwagie-account-[a-z0-9-]+$/).max(120),
  name: z.literal('SuperWagie').default('SuperWagie'),
  apiKey: z.string().min(1).max(8192),
  baseUrl: z.string(),
  models: z.array(z.object({ id: modelIdentifier, name: z.string().trim().min(1).max(256) }).strict()).min(1).max(1000),
  modelId: modelIdentifier,
}).strict();
const nativeModelSchema = z.object({ id: modelIdentifier, providerID: modelIdentifier, variant: modelIdentifier.optional() });
const nativeCatalogSchema = z.array(nativeModelSchema.extend({ modelID: modelIdentifier.optional(), enabled: z.boolean().optional(), variants: z.array(z.object({ id: modelIdentifier })).optional() }));
const settingsSchema = z.object({ smallModelUseDefault: z.boolean().optional(), smallModelOverride: z.string().optional(), smallModelVariant: z.string().optional() });
const nativeTestSchema = z.object({ id: z.enum(['native-agent', 'native-auxiliary']), purpose: z.enum(['agent', 'auxiliary']), providerId: modelIdentifier, modelId: modelIdentifier, variant: modelIdentifier.optional() });
const parseNative = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail(UNAVAILABLE);
  return parsed.data;
};
const readAuxiliarySettings = async (env) => {
  const directory = env.OPENCHAMBER_DATA_DIR ? path.resolve(env.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber');
  const read = async (name) => {
    try { return await fs.readFile(path.join(directory, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const settings = await read('settings.json');
  const preferences = await read('preferences.json');
  const base = settings === null ? {} : parseNative(settingsSchema, JSON.parse(settings));
  if (preferences === null) return base;
  const parsed = parsePreferencesDocument(preferences);
  if (!parsed.ok) return fail(UNAVAILABLE);
  return parseNative(settingsSchema, { ...base, ...flattenPreferences(parsed.fields) });
};
const probeError = (error) => (
  isModelNotFoundError(error) || isProviderNotFoundError(error) || isUnsupportedModelError(error)
  || (isProviderRequestError(error) && error.status >= 400 && error.status < 500 && error.status !== 408)
    ? PROBE_FAILED : PROBE_UNKNOWN
);

// The editor projection strips inline keys. Recovery compares the private
// canonical value too, so a user's later credential edit is a conflict.
const readAccountProviderConfig = (providerId, directory) => {
  const layers = readConfigLayers(directory);
  if (layers.layerErrors.length) return fail(UNAVAILABLE);
  const entries = [layers.userConfig, layers.userOverrideConfig, layers.projectConfig, layers.customConfig]
    .map((config) => readSectionEntry(config, 'providers', providerId).value);
  return {
    config: entries[0] === undefined ? null : toProviderEntity(entries[0]),
    blocked: entries.slice(1).some((entry) => entry !== undefined)
      || layers.mergedConfig.disabled_providers?.includes(providerId) === true,
  };
};

const writeAccountProviderConfig = (providerId, config, directory, scope, options) => {
  // Keep this final read and the owning synchronous write together. The
  // earlier credential lookup may have allowed another configuration edit.
  const current = readAccountProviderConfig(providerId, directory);
  if (current.blocked || (current.config && !isDeepStrictEqual(current.config, config))) return fail(CONFLICT, 409);
  if (!current.config) return writeProviderConfig(providerId, config, directory, scope, options);
};

/** Native provider entry and a single paid-capable text probe for account activation. */
export const createAccountKeyProvider = ({
  env = process.env,
  enterpriseOptions,
  getDefaultDirectory,
  getOpenCodeClient = getSmallModelClient,
  readProviderConfig = readAccountProviderConfig,
  upsertProviderConfig = writeAccountProviderConfig,
  readOpenCodeCredentials = readNativeCredentials,
  readSettings = () => readAuxiliarySettings(env),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date().toISOString(),
} = {}) => {
  const context = async (request, providerEntry = true) => {
    const { assertCurrent, ...raw } = request;
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success || !(assertCurrent instanceof Function)) return fail(INVALID, 400);
    const input = parsed.data;
    if (input.baseUrl !== llmRouterInferenceApiUrl(env)
      || !input.models.some((model) => model.id === input.modelId)
      || new Set(input.models.map((model) => model.id)).size !== input.models.length) return fail(INVALID, 400);
    const validated = validateCustomProviderConfig(input.providerId, {
      name: input.name,
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: input.baseUrl },
      models: Object.fromEntries(input.models.map((model) => [model.id, { name: model.name }])),
    }, { hasStoredAuth: true });
    if (!validated.ok) return fail(INVALID, 400);
    const config = validated.value.config;
    const guard = async () => {
      if (providerEntry && isEnterpriseMode(enterpriseOptions)) return fail('enterprise_mode', 403);
      await assertCurrent();
      if (providerEntry && isEnterpriseMode(enterpriseOptions)) return fail('enterprise_mode', 403);
    };
    const io = async (action, errorCode = () => UNAVAILABLE) => {
      await guard();
      let result;
      try { result = await action(); } catch (error) {
        await guard();
        const code = errorCode(error);
        return fail(code, code === CONFLICT ? 409 : 503);
      }
      await guard();
      return result;
    };
    const directory = await io(() => getDefaultDirectory?.());
    if (!directory) return fail(UNAVAILABLE);
    const inspect = async () => {
      const stored = await io(() => readProviderConfig(input.providerId, directory));
      if (stored.blocked || (stored.config && !isDeepStrictEqual(stored.config, config))) return fail(CONFLICT, 409);
      const credential = (await io(() => readOpenCodeCredentials()))[input.providerId];
      if (credential && (credential.type !== 'api' || credential.key !== input.apiKey)) return fail(CONFLICT, 409);
      return { configured: Boolean(stored.config), credential: Boolean(credential) };
    };
    const client = async () => {
      const value = await io(() => getOpenCodeClient(directory));
      if (!value) return fail(UNAVAILABLE);
      return value;
    };
    return { input, config, directory, io, inspect, client };
  };

  const readPlan = async (native, io) => {
    const skipped = (purpose, errorCode) => ({ id: `native-${purpose}`, purpose, providerId: null, modelId: null, status: 'skipped', errorCode });
    const readRow = async (purpose, action) => {
      try {
        const model = await action();
        if (!model) return skipped(purpose, UNCONFIGURED);
        const row = { id: `native-${purpose}`, purpose, providerId: model.providerID, modelId: model.id };
        if (model.variant) row.variant = model.variant;
        return row;
      } catch (error) {
        if (error.code !== UNAVAILABLE) throw error;
        return skipped(purpose, UNAVAILABLE);
      }
    };
    const defaultModel = await readRow('agent', async () => parseNative(nativeModelSchema.nullable(), (await io(() => native.model.default())).data));
    const auxiliary = await readRow('auxiliary', async () => {
      const settings = parseNative(settingsSchema, await io(() => readSettings()));
      const models = parseNative(nativeCatalogSchema, (await io(() => native.model.list())).data);
      const info = (model) => models.find((entry) => entry.providerID === model.providerID && entry.id === model.id)
        ?? models.find((entry) => entry.providerID === model.providerID && entry.modelID === model.id);
      let model;
      if (settings.smallModelUseDefault === false && settings.smallModelOverride?.trim()) {
        const value = settings.smallModelOverride.trim();
        const slash = value.indexOf('/');
        if (slash <= 0 || slash === value.length - 1) return fail(UNAVAILABLE);
        const selection = { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
        if (settings.smallModelVariant?.trim()) selection.variant = settings.smallModelVariant.trim();
        model = parseNative(nativeModelSchema, selection);
        if (info(model)?.enabled === false) return fail(UNAVAILABLE);
      } else {
        const title = parseNative(z.object({ id: z.literal('title'), model: nativeModelSchema.optional() }), (await io(() => native.agent.get({ agentID: 'title' }))).data);
        model = title.model;
        if (model && info(model)?.enabled === false) model = undefined;
      }
      if (!model) {
        if (defaultModel.errorCode === UNAVAILABLE) return fail(UNAVAILABLE);
        return defaultModel.modelId ? { providerID: defaultModel.providerId, id: defaultModel.modelId } : null;
      }
      const known = info(model);
      if (model.variant && known && !known.variants?.some((variant) => variant.id === model.variant)) {
        const { variant: _variant, ...withoutVariant } = model;
        return withoutVariant;
      }
      return model;
    });
    return [defaultModel, auxiliary];
  };

  const inspectConfigured = async (inspect) => {
    const stored = await inspect();
    if (!stored.configured || !stored.credential) return fail(CONFLICT, 409);
  };

  return {
    planTests: async (request) => {
      const { directory, io, inspect, client } = await context(request);
      await inspectConfigured(inspect);
      const plan = await readPlan(await client(), io);
      if (await io(() => getDefaultDirectory?.()) !== directory) return fail(CONFLICT, 409);
      return plan;
    },
    probeConfiguredModel: async (request, target) => {
      const parsed = nativeTestSchema.safeParse(target);
      if (!parsed.success || parsed.data.id !== `native-${parsed.data.purpose}`) return fail(INVALID, 400);
      const selected = parsed.data;
      const { directory, io, inspect, client } = await context(request);
      await inspectConfigured(inspect);
      const native = await client();
      const assertSelection = async () => {
        const current = (await readPlan(native, io)).find((entry) => entry.id === selected.id);
        if (!isDeepStrictEqual(current, selected) || await io(() => getDefaultDirectory?.()) !== directory) return fail(CONFLICT, 409);
      };
      await assertSelection();
      const model = { providerID: selected.providerId, id: selected.modelId };
      if (selected.variant) model.variant = selected.variant;
      const result = await io(() => native.experimental.generate.text({
        prompt: 'Reply with OK.', model,
      }, { signal: AbortSignal.timeout(30_000) }), probeError);
      if (!z.string().trim().min(1).safeParse(result?.text).success) return fail(PROBE_FAILED);
      await assertSelection();
      await inspectConfigured(inspect);
      return { status: 'verified', testedAt: now() };
    },
    verify: async (request) => {
      const { inspect } = await context(request, false);
      const stored = await inspect();
      if (!stored.configured || !stored.credential) return fail(CONFLICT, 409);
    },
    configure: async (request) => {
      const { input, config, directory, io, inspect, client } = await context(request);
      const initial = await inspect();
      if (!initial.configured) {
        await io(() => upsertProviderConfig(input.providerId, config, directory, 'user', { hasStoredAuth: true }),
          (error) => error?.code === CONFLICT ? CONFLICT : UNAVAILABLE);
      }
      const stored = await inspect();
      if (!stored.configured) return fail(UNAVAILABLE);
      if (!stored.credential) {
        const native = await client();
        // Config reaches OpenCode through its watcher. Poll only the read;
        // credential creation and generation are never automatically repeated.
        for (let attempt = 0; ; attempt += 1) {
          const integration = await io(async () => {
            try { return await native.integration.get({ integrationID: input.providerId }); }
            catch (error) {
              if (isIntegrationNotFoundError(error) && error.integrationID === input.providerId) return null;
              throw error;
            }
          });
          if (integration?.data.methods.some((method) => method.type === 'key')) break;
          if (READY_DELAYS_MS[attempt] === undefined) return fail(UNAVAILABLE);
          await io(() => wait(READY_DELAYS_MS[attempt]));
        }
        const beforeWrite = await inspect();
        if (!beforeWrite.configured) return fail(CONFLICT, 409);
        if (!beforeWrite.credential) await io(() => native.integration.connect.key({ integrationID: input.providerId, key: input.apiKey }));
      }
      const result = await inspect();
      if (!result.configured || !result.credential) return fail(UNAVAILABLE);
      return { providerId: input.providerId, modelId: input.modelId };
    },
    probe: async (request) => {
      const { input, io, inspect, client } = await context(request);
      const before = await inspect();
      if (!before.configured || !before.credential) return fail(CONFLICT, 409);
      const native = await client();
      const result = await io(() => native.experimental.generate.text({
        prompt: 'Reply with OK.', model: { providerID: input.providerId, id: input.modelId },
      }, { signal: AbortSignal.timeout(30_000) }), probeError);
      if (!z.string().trim().min(1).safeParse(result?.text).success) return fail(PROBE_FAILED);
      const after = await inspect();
      if (!after.configured || !after.credential) return fail(CONFLICT, 409);
      return { status: 'verified', testedAt: now() };
    },
  };
};
