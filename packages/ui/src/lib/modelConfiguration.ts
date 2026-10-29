import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const purposeIds = ['agent', 'auxiliary', 'ocr', 'vision', 'embedding', 'rerank', 'stt-short', 'stt-realtime', 'stt-file', 'tts', 'image-generation', 'image-editing', 'routing', 'multimodal-embedding', 'video-generation'] as const;
const protocols = ['openai-compatible', 'aliyun', 'volcengine', 'gemini', 'anthropic', 'paddleocr', 'mistral-ocr', 'azure-document', 'cohere', 'voyage', 'elevenlabs', 'deepgram', 'minimax', 'jev', 'managed-media'] as const;
const parametersSchema = z.object({ dimensions: z.number().int().positive().optional(), voice: z.string().optional(), language: z.string().optional(), workspaceId: z.string().optional(), region: z.string().optional() }).strict();
const credentialSourceSchema = z.object({ type: z.literal('opencode'), providerId: z.string() }).strict();
const purposeSchema = z.object({ id: z.enum(purposeIds), labelKey: z.string(), status: z.enum(['native', 'available', 'planned']), consumerIds: z.array(z.string()), required: z.boolean(), probeProtocols: z.array(z.enum(protocols)).optional() });
const presetSchema = z.object({
  id: z.string(), providerId: z.string(), name: z.string(), origin: z.enum(['china', 'international', 'local']),
  purposes: z.array(z.enum(purposeIds)), protocol: z.enum(protocols), model: z.string(), baseUrl: z.string(),
  docsUrl: z.string().url(), keyUrl: z.string().url(), parameters: parametersSchema,
  status: z.enum(['compatible', 'requires-adapter', 'planned']), notes: z.array(z.string()), noteCodes: z.array(z.enum(['preserve-existing-index', 'openai-tts-retirement', 'reference-edit-not-mask', 'editable-ppt-excluded', 'buffered-dictation'])).default([]), reviewedAt: z.string(),
});
const connectionSchema = z.object({
  id: z.string(), name: z.string(), providerId: z.string(), protocol: z.enum(protocols), baseUrl: z.string().url(),
  region: z.string().optional(), workspaceId: z.string().optional(), hasApiKey: z.boolean(),
  credentialSource: credentialSourceSchema.optional(),
}).strict();
const bindingSchema = z.object({
  purpose: z.enum(purposeIds), connectionId: z.string(), presetId: z.string().optional(), model: z.string(), parameters: parametersSchema,
  verification: z.object({ status: z.enum(['untested', 'verified', 'failed']), testedAt: z.string().optional(), errorCode: z.string().optional() }),
});
const configurationSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), enterpriseMode: z.boolean(), purposes: z.array(purposeSchema), presets: z.array(presetSchema), connections: z.array(connectionSchema), bindings: z.array(bindingSchema), credentialSources: z.object({ status: z.enum(['available', 'unavailable', 'failed']), sources: z.array(credentialSourceSchema.extend({ name: z.string().optional() })) }) });
export type ModelPurposeId = z.infer<typeof purposeSchema>['id'];
export type ModelPurpose = z.infer<typeof purposeSchema>;
export type ModelPreset = z.infer<typeof presetSchema>;
export type ModelConnection = z.infer<typeof connectionSchema>;
export type ModelBinding = z.infer<typeof bindingSchema>;
export type ModelConfiguration = z.infer<typeof configurationSchema>;
export type ModelConnectionInput = Omit<ModelConnection, 'id' | 'hasApiKey' | 'credentialSource'> & { id?: string } & ({ credentialSource: z.infer<typeof credentialSourceSchema>; apiKey?: never } | { credentialSource?: never; apiKey?: string });
export type ModelBindingInput = Omit<ModelBinding, 'purpose' | 'verification'>;
export type ModelConnectionTestInput = Omit<ModelBindingInput, 'connectionId'> & { purpose: ModelPurposeId };
const connectionTestSchema = z.object({ status: z.enum(['verified', 'failed']), testedAt: z.string(), errorCode: z.string().optional() }).strict();
export type ModelConnectionTestResult = z.infer<typeof connectionTestSchema>;
export class ModelConfigurationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ModelConfigurationError'; this.code = code; }
}
const errorSchema = z.object({ error: z.string() });
const readValidatedResponse = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  let body: unknown;
  try { body = await response.json(); } catch { throw new ModelConfigurationError(response.ok ? 'bad_response' : `http_${response.status}`); }
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    throw new ModelConfigurationError(error.success ? error.data.error : `http_${response.status}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ModelConfigurationError('bad_response');
  return parsed.data;
};
const readResponse = (response: Response): Promise<ModelConfiguration> => readValidatedResponse(response, configurationSchema);
export const readModelConfiguration = async (signal?: AbortSignal): Promise<ModelConfiguration> => readResponse(await runtimeFetch('/api/model-configuration', { signal }));
const mutate = async (path: string, method: string, body: { revision: number; connection?: ModelConnectionInput; binding?: ModelBindingInput | null }): Promise<ModelConfiguration> => readResponse(await runtimeFetch(`/api/model-configuration${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
export const saveModelConnection = (revision: number, connection: ModelConnectionInput): Promise<ModelConfiguration> => mutate('/connections', 'POST', { revision, connection });
export const removeModelConnection = (id: string, revision: number): Promise<ModelConfiguration> => mutate(`/connections/${encodeURIComponent(id)}`, 'DELETE', { revision });
export const saveModelBinding = (purpose: ModelPurposeId, revision: number, binding: ModelBindingInput | null): Promise<ModelConfiguration> => mutate(`/bindings/${encodeURIComponent(purpose)}`, 'PUT', { revision, binding });
export const testModelBinding = (purpose: ModelPurposeId, revision: number): Promise<ModelConfiguration> => mutate(`/bindings/${encodeURIComponent(purpose)}/test`, 'POST', { revision });
export const testModelConnection = async (id: string, revision: number, input: ModelConnectionTestInput): Promise<ModelConnectionTestResult> => readValidatedResponse(await runtimeFetch(`/api/model-configuration/connections/${encodeURIComponent(id)}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, ...input }) }), connectionTestSchema);
