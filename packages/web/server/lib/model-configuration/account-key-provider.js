import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isIntegrationNotFoundError, isModelNotFoundError, isProviderNotFoundError, isProviderRequestError, isUnsupportedModelError } from '@opencode/client';
import { z } from 'zod';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { readOpenCodeCredentials as readNativeCredentials } from '../opencode/auth.js';
import { parseModelSelection, readSectionEntry, toProviderEntity } from '../opencode/config-v2.js';
import { upsertProviderConfig as writeProviderConfig, validateCustomProviderConfig } from '../opencode/providers.js';
import { readConfigLayers } from '../opencode/shared.js';
import { flattenPreferences, parsePreferencesDocument } from '../opencode/settings-files.js';
import { getSmallModelClient } from '../small-model/client.js';
import { llmRouterInferenceApiUrl } from './bootstrap-endpoints.js';
import { accountModelSchema, accountProviderModels } from './account-key-models.js';

const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }); };
const UNAVAILABLE = 'model_configuration_account_provider_unavailable';
const RUNTIME_REQUIRED = 'model_configuration_account_runtime_required';
const RUNTIME_UNAVAILABLE = 'model_configuration_account_runtime_unavailable';
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
  models: z.array(accountModelSchema).min(1).max(1000),
  previousModels: z.array(accountModelSchema).min(1).max(1000).optional(),
  modelId: modelIdentifier,
}).strict();
const nativeModelSchema = z.object({ id: modelIdentifier, providerID: modelIdentifier, variant: modelIdentifier.optional() });
const nativeCatalogSchema = z.array(nativeModelSchema.extend({ modelID: modelIdentifier.optional(), enabled: z.boolean().optional(), variants: z.array(z.object({ id: modelIdentifier })).optional() }));
const settingsSchema = z.object({ defaultModel: z.string().optional(), defaultVariant: z.string().optional(), smallModelUseDefault: z.boolean().optional(), smallModelOverride: z.string().optional(), smallModelVariant: z.string().optional() });
const nativeSelectionSchema = z.object({ providerID: modelIdentifier, modelID: modelIdentifier, variant: modelIdentifier.optional() });
const configuredModelSchema = z.union([z.string(), z.object({ providerID: z.string(), modelID: z.string().optional(), model: z.string().optional(), variant: z.string().optional() })])
  .transform((model) => parseModelSelection(model)).pipe(nativeSelectionSchema);
const nativeSelectionsSchema = z.object({ agent: nativeSelectionSchema.nullable(), auxiliary: nativeSelectionSchema.nullable() }).strict();
const configEntriesSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('directory') }),
  z.object({ type: z.literal('document'), info: z.object({
    model: configuredModelSchema.optional(),
    agents: z.object({ title: z.object({ model: configuredModelSchema.optional() }).optional() }).optional(),
  }) }),
]));
const selectionSchema = z.object({ purpose: z.enum(['agent', 'auxiliary']), modelId: modelIdentifier });
const selectionSettings = (settings, purpose) => purpose === 'agent'
  ? { defaultModel: settings.defaultModel, defaultVariant: settings.defaultVariant }
  : { smallModelUseDefault: settings.smallModelUseDefault, smallModelOverride: settings.smallModelOverride, smallModelVariant: settings.smallModelVariant };
const nativeTestSchema = z.object({ id: z.enum(['native-agent', 'native-auxiliary']), purpose: z.enum(['agent', 'auxiliary']), providerId: modelIdentifier, modelId: modelIdentifier, variant: modelIdentifier.optional() });
const parseNative = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail(UNAVAILABLE);
  return parsed.data;
};

/** Compare the explicit native choices that the original app settings inherit. */
export const accountNativeSelectionsMatch = (expected, current, settings, purpose) => {
  if (purpose === 'agent') return Boolean(settings.defaultModel?.trim()) || isDeepStrictEqual(expected.agent, current.agent);
  if (settings.smallModelUseDefault === false && settings.smallModelOverride?.trim()) return true;
  if (!isDeepStrictEqual(expected.auxiliary, current.auxiliary)) return false;
  return Boolean(expected.auxiliary || settings.defaultModel?.trim()) || isDeepStrictEqual(expected.agent, current.agent);
};

const readNativeSelections = async (native, io) => {
  const entries = parseNative(configEntriesSchema, await io(() => native.config.get(undefined, { signal: AbortSignal.timeout(10_000) })));
  const selections = { agent: null, auxiliary: null };
  for (const entry of entries) {
    if (entry.type !== 'document') continue;
    if (entry.info.model !== undefined) selections.agent = entry.info.model;
    // A later title agent definition replaces the earlier definition as a whole.
    if (entry.info.agents?.title !== undefined) selections.auxiliary = entry.info.agents.title.model ?? null;
  }
  return selections;
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
  if (current.blocked || (current.config && !isDeepStrictEqual(current.config, config) && !isDeepStrictEqual(current.config, options.previousConfig))) return fail(CONFLICT, 409);
  if (!isDeepStrictEqual(current.config, config)) return writeProviderConfig(providerId, config, directory, scope, { hasStoredAuth: true, replaceModelCatalog: true });
};

/** Native provider entry and a single paid-capable text probe for account activation. */
export const createAccountKeyProvider = ({
  env = process.env,
  enterpriseOptions,
  assertRuntime,
  getDefaultDirectory,
  getOpenCodeClient = getSmallModelClient,
  readProviderConfig = readAccountProviderConfig,
  upsertProviderConfig = writeAccountProviderConfig,
  readOpenCodeCredentials = readNativeCredentials,
  readSettings = () => readAuxiliarySettings(env),
  writeSettings,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date().toISOString(),
} = {}) => {
  const runtimeIdentity = async () => {
    try {
      const runtime = await assertRuntime?.();
      if (runtime) return runtime;
    } catch (error) {
      if (error?.code === RUNTIME_REQUIRED || error?.code === RUNTIME_UNAVAILABLE) return fail(error.code);
    }
    return fail(RUNTIME_UNAVAILABLE);
  };
  const bindRuntime = async (assertCurrent) => {
    const runtime = await runtimeIdentity();
    return async () => {
      if (await runtimeIdentity() !== runtime) return fail(RUNTIME_UNAVAILABLE);
      await assertCurrent();
      if (await runtimeIdentity() !== runtime) return fail(RUNTIME_UNAVAILABLE);
    };
  };
  const context = async (request, providerEntry = true) => {
    const { assertCurrent, ...raw } = request;
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success || !(assertCurrent instanceof Function)) return fail(INVALID, 400);
    const assertRuntimeCurrent = await bindRuntime(assertCurrent);
    const input = parsed.data;
    if (input.baseUrl !== llmRouterInferenceApiUrl(env)
      || !input.models.some((model) => model.id === input.modelId)
      || new Set(input.models.map((model) => model.id)).size !== input.models.length) return fail(INVALID, 400);
    const validated = validateCustomProviderConfig(input.providerId, {
      name: input.name,
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: input.baseUrl },
      models: accountProviderModels(input.models, input.baseUrl),
    }, { hasStoredAuth: true });
    if (!validated.ok) return fail(INVALID, 400);
    const config = validated.value.config;
    let previousConfig;
    if (input.previousModels) {
      if (new Set(input.previousModels.map((model) => model.id)).size !== input.previousModels.length) return fail(INVALID, 400);
      const previous = validateCustomProviderConfig(input.providerId, { name: input.name, package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: input.baseUrl }, models: accountProviderModels(input.previousModels, input.baseUrl) }, { hasStoredAuth: true });
      if (!previous.ok) return fail(INVALID, 400);
      previousConfig = previous.value.config;
    }
    const guard = async () => {
      if (providerEntry && isEnterpriseMode(enterpriseOptions)) return fail('enterprise_mode', 403);
      await assertRuntimeCurrent();
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
      const configured = isDeepStrictEqual(stored.config, config);
      const previous = previousConfig && isDeepStrictEqual(stored.config, previousConfig);
      if (stored.blocked || (stored.config && !configured && !previous)) return fail(CONFLICT, 409);
      const credential = (await io(() => readOpenCodeCredentials()))[input.providerId];
      if (credential && (credential.type !== 'api' || credential.key !== input.apiKey)) return fail(CONFLICT, 409);
      if (previous && !configured && !credential) return fail(CONFLICT, 409);
      return { configured, credential: Boolean(credential) };
    };
    const client = async () => {
      const value = await io(() => getOpenCodeClient(directory));
      if (!value) return fail(UNAVAILABLE);
      return value;
    };
    return { input, config, previousConfig, directory, io, inspect, client, guard };
  };

  const readPlan = async (native, io, snapshot) => {
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
    let settings;
    try { settings = snapshot ?? parseNative(settingsSchema, await io(() => readSettings())); }
    catch (error) {
      if (error.code !== UNAVAILABLE) throw error;
      return [skipped('agent', UNAVAILABLE), skipped('auxiliary', UNAVAILABLE)];
    }
    const configuredSelection = (value, variant) => {
      const slash = value.indexOf('/');
      if (slash <= 0 || slash === value.length - 1) return fail(UNAVAILABLE);
      const selection = { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
      if (variant?.trim()) selection.variant = variant.trim();
      return parseNative(nativeModelSchema, selection);
    };
    const defaultModel = await readRow('agent', async () => settings.defaultModel?.trim()
      ? configuredSelection(settings.defaultModel.trim(), settings.defaultVariant)
      : parseNative(nativeModelSchema.nullable(), (await io(() => native.model.default())).data));
    const auxiliary = await readRow('auxiliary', async () => {
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
        if (info(model)?.enabled === false) return null;
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

  const verifySelection = async (request, target) => {
    const selected = parseNative(selectionSchema, target);
    const { input, directory, io, inspect, client } = await context(request);
    if (!input.models.some((model) => model.id === selected.modelId)) return fail(INVALID, 400);
    await inspectConfigured(inspect);
    const row = (await readPlan(await client(), io)).find((entry) => entry.purpose === selected.purpose);
    if (row?.providerId !== input.providerId || row.modelId !== selected.modelId || row.variant || await io(() => getDefaultDirectory?.()) !== directory) return fail(CONFLICT, 409);
    return { purpose: selected.purpose, providerId: row.providerId, modelId: row.modelId };
  };

  return {
    readConfiguredModels: async ({ assertCurrent }) => {
      if (!(assertCurrent instanceof Function)) return fail(INVALID, 400);
      const guard = await bindRuntime(assertCurrent);
      const io = async (action) => {
        await guard();
        let value;
        try { value = await action(); }
        catch { await guard(); return fail(UNAVAILABLE); }
        await guard();
        return value;
      };
      const directory = await io(() => getDefaultDirectory?.());
      if (!directory) return fail(UNAVAILABLE);
      const native = await io(() => getOpenCodeClient(directory));
      if (!native) return fail(UNAVAILABLE);
      const settings = parseNative(settingsSchema, await io(() => readSettings()));
      const nativeSelections = await readNativeSelections(native, io);
      const models = await readPlan(native, io, settings);
      if (await io(() => getDefaultDirectory?.()) !== directory) return fail(CONFLICT, 409);
      return { models, settings, nativeSelections };
    },
    selectConfiguredModel: async (request, target) => {
      const selected = parseNative(selectionSchema, target);
      const expected = parseNative(settingsSchema, target.expectedSettings);
      const expectedNative = parseNative(nativeSelectionsSchema, target.expectedNativeSelections);
      const { input, directory, io, inspect, client, guard } = await context(request);
      if (!input.models.some((model) => model.id === selected.modelId)) return fail(INVALID, 400);
      if (!(writeSettings instanceof Function)) return fail(UNAVAILABLE);
      await inspectConfigured(inspect);
      const assertSelection = async () => {
        await inspectConfigured(inspect);
        if (await io(() => getDefaultDirectory?.()) !== directory) return fail(CONFLICT, 409);
        const current = parseNative(settingsSchema, await io(() => readSettings()));
        if (!isDeepStrictEqual(selectionSettings(current, selected.purpose), selectionSettings(expected, selected.purpose))) return fail(CONFLICT, 409);
        const nativeSelections = await readNativeSelections(await client(), io);
        if (!accountNativeSelectionsMatch(expectedNative, nativeSelections, expected, selected.purpose)) return fail(CONFLICT, 409);
      };
      await assertSelection();
      const model = `${input.providerId}/${selected.modelId}`;
      const changes = selected.purpose === 'agent' ? { defaultModel: model, defaultVariant: '' }
        : { smallModelUseDefault: false, smallModelOverride: model, smallModelVariant: '' };
      await io(() => writeSettings(changes, assertSelection), (error) => error?.code === CONFLICT ? CONFLICT : UNAVAILABLE);
      return verifySelection({ ...request, assertCurrent: guard }, selected);
    },
    verifyConfiguredModel: verifySelection,
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
      const { input, config, previousConfig, directory, io, inspect, client } = await context(request);
      const initial = await inspect();
      if (!initial.configured) {
        const options = { hasStoredAuth: true };
        if (previousConfig) options.previousConfig = previousConfig;
        await io(() => upsertProviderConfig(input.providerId, config, directory, 'user', options),
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
