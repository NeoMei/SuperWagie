import stripJsonComments from 'strip-json-comments';
import { z } from 'zod';
import {
  CUSTOM_PROVIDER_PROTOCOLS,
  providerToCustomFormState,
  type CustomProviderFormState,
  type CustomProviderProtocol,
} from './custom-provider-form';

export const LOCAL_PROVIDER_IMPORT_MAX_BYTES = 1024 * 1024;

const fields = z.record(z.string(), z.unknown());
type ImportFields = z.infer<typeof fields>;
const nonblank = z.string().trim().min(1);
const positive = z.number().int().positive();
const textList = z.array(nonblank);
const providerID = z.string().regex(/^[a-z0-9][a-z0-9-_]*$/);
const protocol = z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']);
const model = z.object({
  id: nonblank.optional(),
  modelID: nonblank.optional(),
  name: nonblank.optional(),
  limit: z.object({ context: positive.optional(), output: positive.optional() }).optional(),
  capabilities: z.object({ tools: z.boolean().optional(), input: textList.optional(), output: textList.optional() }).optional(),
  modalities: z.object({ input: textList.optional(), output: textList.optional() }).optional(),
  tool_call: z.boolean().optional(),
});

const packageProtocols = new Map<string, CustomProviderProtocol>([
  ['@ai-sdk/openai-compatible', 'openai-chat'],
  ['@ai-sdk/openai', 'openai-responses'],
  ['@ai-sdk/anthropic', 'anthropic-messages'],
  ['@opencode/ai/providers/openai-compatible', 'openai-chat'],
  ['@opencode/ai/providers/openai', 'openai-responses'],
  ['@opencode/ai/providers/anthropic', 'anthropic-messages'],
]);

const readFields = fields.catch({}).parse;
const readString = nonblank.optional().catch(undefined).parse;
const readPositive = positive.optional().catch(undefined).parse;

const endpoint = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
};

const readProtocol = (source: ImportFields): CustomProviderProtocol | undefined => {
  const adapter = readString(source.protocol) ?? readString(source.adapter);
  if (adapter) return protocol.safeParse(adapter).data;
  const name = readString(source.package) ?? readString(source.npm);
  return name ? packageProtocols.get(name.replace(/^aisdk:/, '')) : 'openai-chat';
};

const readModels = (source: ImportFields) => {
  const displayNames = readFields(source.modelDisplayNames);
  const contexts = readFields(source.modelContextWindows);
  const outputs = readFields(source.modelMaxOutputTokens);
  const inputModes = readFields(source.modelInputModalities);
  const reasoning = readFields(source.modelReasoningEfforts);
  const items = Array.isArray(source.models)
    ? source.models.map((entry) => [readString(entry), entry] as const)
    : Object.entries(readFields(source.models));
  const seen = new Set<string>();
  return items.flatMap(([key, entry]) => {
    const raw = readFields(entry);
    const info = model.safeParse(raw).data;
    const id = info?.modelID ?? info?.id ?? key;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const input = info?.capabilities?.input ?? info?.modalities?.input ?? textList.safeParse(inputModes[id]).data;
    const output = info?.capabilities?.output ?? info?.modalities?.output;
    const tools = info?.capabilities?.tools ?? info?.tool_call;
    const variantIDs = textList.safeParse(reasoning[id]).data
      ?? (Array.isArray(raw.variants)
        ? raw.variants.flatMap((variant) => readString(readFields(variant).id) ?? [])
        : Object.keys(readFields(raw.variants)));
    return [{
      modelID: id,
      name: info?.name ?? readString(displayNames[id]) ?? id,
      limit: {
        context: info?.limit?.context ?? readPositive(contexts[id]),
        output: info?.limit?.output ?? readPositive(outputs[id]),
      },
      capabilities: input || output || tools !== undefined ? { input, output, tools } : undefined,
      variants: [...new Set(variantIDs)].filter((name) => /^[a-zA-Z0-9_-]{1,40}$/.test(name)).map((id) => ({ id })),
    }];
  });
};

const readProvider = (id: string, source: ImportFields): CustomProviderFormState | null => {
  if (!providerID.safeParse(id).success) return null;
  const baseURL = endpoint(
    readString(readFields(source.settings).baseURL) ?? readString(readFields(source.options).baseURL)
      ?? readString(source.baseURL) ?? readString(source.baseUrl),
  );
  const adapter = readProtocol(source);
  if (!baseURL || !adapter) return null;
  const models = readModels(source);
  if (!models.length) return null;

  // Construct the preview from allowlisted fields. Configs can contain literal
  // secrets in options, headers, model overrides, and account pools.
  return providerToCustomFormState({
    id,
    name: readString(source.name),
    settings: { baseURL },
    package: CUSTOM_PROVIDER_PROTOCOLS[adapter],
    models,
  });
};

export function readLocalProviderConfig(text: string) {
  const root = readFields(JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''), { trailingCommas: true })));
  const source = root.providers ?? root.provider ?? [root];
  const entries = Array.isArray(source)
    ? source.map((item) => {
        const row = readFields(item);
        return [readString(row.id) ?? readString(row.providerID) ?? '', row] as const;
      })
    : Object.entries(readFields(source)).map(([id, row]) => [id, readFields(row)] as const);
  const providers = entries.flatMap(([id, row]) => readProvider(id, row) ?? []);
  return { providers, skipped: entries.length - providers.length };
}

export function mergeImportedProviderModels(
  current: CustomProviderFormState,
  source: CustomProviderFormState,
): CustomProviderFormState | null {
  const configured = current.baseURL.trim().length > 0;
  if (configured && (endpoint(current.baseURL) !== endpoint(source.baseURL) || current.protocol !== source.protocol)) return null;
  const kept = current.models.filter((entry) => entry.id.trim() || entry.name.trim());
  const ids = new Set(kept.map((entry) => entry.id.trim()));
  return {
    ...current,
    providerID: current.providerID || source.providerID,
    name: current.name || source.name,
    baseURL: configured ? current.baseURL : source.baseURL,
    protocol: configured ? current.protocol : source.protocol,
    models: [...kept, ...source.models.filter((entry) => !ids.has(entry.id))],
  };
}
