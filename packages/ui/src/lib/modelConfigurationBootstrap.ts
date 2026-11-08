import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { modelConfigurationSchema, type ModelConfiguration, type ModelPurposeId } from './modelConfiguration';

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  operations: z.array(z.string()).default([]),
  inputModalities: z.array(z.string()).default([]),
  outputModalities: z.array(z.string()).default([]),
  context: z.number().int().nonnegative().nullable().optional(),
  maxOutput: z.number().int().nonnegative().nullable().optional(),
  dimensions: z.number().int().min(1).max(65536).nullable().optional(),
  probe: z.boolean().default(false),
  rateId: z.string().nullable().optional(),
  recommendation: z.number().optional(),
  cost: z.number().nullable().optional(),
}).strict();

const discoverySchema = z.object({
  discoveryId: z.string().min(1),
  source: z.enum(['session', 'imported-key']),
  fundingMode: z.enum(['credits', 'prepaid_cash']).optional(),
  accountId: z.string().nullable().optional(),
  instanceId: z.string().nullable().optional(),
  originProductId: z.string().optional(),
  keyFingerprint: z.string().nullable().optional(),
  keyLast4: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  availableCredits: z.number().nonnegative().optional(),
  models: z.array(modelSchema).optional(),
  catalog: z.array(modelSchema).optional(),
}).strict().transform((value) => ({ ...value, models: value.models ?? value.catalog ?? [] }));

const planEntrySchema = z.object({
  purpose: z.string(),
  model: z.string().optional(),
  modelName: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  cost: z.number().nullable().optional(),
  currentModel: z.string().optional(),
  connectionId: z.string().optional(),
  candidates: z.array(z.object({ id: z.string(), name: z.string() }).strict()).optional(),
}).passthrough();

const previewSchema = z.object({
  operationId: z.string().min(1),
  discoveryId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  mode: z.enum(['fill-missing', 'replace-managed']),
  add: z.array(planEntrySchema).default([]),
  replace: z.array(planEntrySchema).default([]),
  preserve: z.array(planEntrySchema).default([]),
  unavailable: z.array(planEntrySchema.extend({ reason: z.string() })).default([]),
  costs: z.object({ free: z.number().nonnegative().optional(), estimated: z.number().nonnegative().optional() }).passthrough().optional(),
}).transform((value) => ({
  ...value,
  items: [
    ...value.add.map((item) => ({ purpose: item.purpose, action: 'add' as const, modelId: item.model, recommendedModel: item.model, candidates: item.candidates, estimatedCost: item.cost ?? undefined, reason: undefined })),
    ...value.replace.map((item) => ({ purpose: item.purpose, action: 'replace' as const, modelId: item.model, currentModel: item.currentModel, recommendedModel: item.model, candidates: item.candidates, estimatedCost: item.cost ?? undefined, requiresConfirmation: true, reason: undefined })),
    ...value.preserve.map((item) => ({ purpose: item.purpose, action: 'preserve' as const, modelId: item.currentModel ?? item.model, currentModel: item.currentModel, recommendedModel: item.model, candidates: item.candidates, reason: undefined })),
    ...value.unavailable.map((item) => ({ purpose: item.purpose, action: 'unavailable' as const, modelId: null, reason: item.reason })),
  ],
}));

const testResultSchema = z.object({
  purpose: z.string(),
  status: z.enum(['pending', 'discovered', 'configured', 'verified', 'failed', 'unavailable', 'skipped', 'stale']),
  errorCode: z.string().optional(),
}).strict();

const testRunSchema = z.object({
  testRunId: z.string().min(1),
  status: z.enum(['queued', 'running', 'complete', 'completed', 'failed']).default('queued'),
  revision: z.number().int().nonnegative().optional(),
  purposes: z.record(z.string(), z.object({ status: z.enum(['pending', 'verified', 'failed', 'unavailable', 'skipped', 'stale']), errorCode: z.string().optional() })).optional(),
  results: z.array(testResultSchema).default([]),
}).transform((value) => ({ ...value, status: value.status === 'complete' ? 'completed' as const : value.status, results: value.results.length ? value.results : Object.entries(value.purposes ?? {}).map(([purpose, result]) => ({ purpose, status: result.status, errorCode: result.errorCode })) }));

const errorSchema = z.object({ error: z.string() });

export type ModelBootstrapDiscovery = z.infer<typeof discoverySchema>;
export type ModelBootstrapPreview = z.infer<typeof previewSchema>;
export type ModelBootstrapTestRun = z.infer<typeof testRunSchema>;
type ModelBootstrapRollback = { operationId: string; rolledBack: boolean; revision: number };
type ModelBootstrapSource = z.infer<typeof discoverySchema>['source'];
export type ModelBootstrapMode = z.infer<typeof previewSchema>['mode'];
type BootstrapRequestBody = {
  fundingMode?: 'credits' | 'prepaid_cash';
  source?: ModelBootstrapSource;
  key?: string;
  models?: string[];
  expiresAt?: string;
  discoveryId?: string;
  operationId?: string;
  revision?: number;
  mode?: ModelBootstrapMode;
  purposes?: ModelPurposeId[];
  selections?: Record<string, string>;
  expensive?: boolean;
};
export type ModelBootstrapClient = {
  discover: typeof discoverModelBootstrap;
  issueKey: typeof issueModelBootstrapKey;
  preview: typeof previewModelBootstrap;
  apply: typeof applyModelBootstrap;
  startTests: typeof startModelBootstrapTests;
  readTestRun: typeof readModelBootstrapTestRun;
  rollback: typeof rollbackModelBootstrap;
};

export class ModelConfigurationBootstrapError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ModelConfigurationBootstrapError'; this.code = code; }
}

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new ModelConfigurationBootstrapError(response.ok ? 'bad_response' : `http_${response.status}`); }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    const message = parsed.success ? parsed.data.error : `http_${response.status}`;
    const safeCode = /key|token|secret|credential|account|instance/i.test(message) ? 'request_failed' : message;
    throw new ModelConfigurationBootstrapError(safeCode);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ModelConfigurationBootstrapError('bad_response');
  return parsed.data;
}

const postJson = async <T>(path: string, body: BootstrapRequestBody, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => readJson(await runtimeFetch(path, {
  method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), schema);

export const discoverModelBootstrap = (input: { source: ModelBootstrapSource; key?: string; fundingMode?: 'credits' | 'prepaid_cash' }, signal?: AbortSignal): Promise<ModelBootstrapDiscovery> =>
  postJson('/api/model-configuration/bootstrap/discover', input, discoverySchema, signal);

export const issueModelBootstrapKey = (input: { models?: string[]; expiresAt?: string; fundingMode?: 'credits' | 'prepaid_cash' }, signal?: AbortSignal): Promise<ModelBootstrapDiscovery> =>
  postJson('/api/model-configuration/bootstrap/issue-key', input, discoverySchema, signal);

export const previewModelBootstrap = (input: { discoveryId: string; revision: number; mode: ModelBootstrapMode; purposes?: ModelPurposeId[]; selections?: Record<string, string> }, signal?: AbortSignal): Promise<ModelBootstrapPreview> =>
  postJson('/api/model-configuration/bootstrap/preview', input, previewSchema, signal);

export const applyModelBootstrap = (input: { operationId: string; discoveryId: string; revision: number; mode: ModelBootstrapMode; selections?: Record<string, string> }, signal?: AbortSignal): Promise<ModelConfiguration> =>
  postJson('/api/model-configuration/bootstrap/apply', input, z.object({ configuration: modelConfigurationSchema }).transform((body) => body.configuration), signal);

export const startModelBootstrapTests = (input: { revision: number; purposes: ModelPurposeId[]; expensive?: boolean }, signal?: AbortSignal): Promise<ModelBootstrapTestRun> =>
  postJson('/api/model-configuration/bootstrap/test', input, testRunSchema, signal);

export const readModelBootstrapTestRun = (testRunId: string, signal?: AbortSignal): Promise<ModelBootstrapTestRun> =>
  runtimeFetch(`/api/model-configuration/bootstrap/test/${encodeURIComponent(testRunId)}`, { signal }).then((response) => readJson(response, testRunSchema));

export const rollbackModelBootstrap = (input: { operationId: string; revision: number }, signal?: AbortSignal): Promise<ModelBootstrapRollback> =>
  postJson('/api/model-configuration/bootstrap/rollback', input, z.object({ operationId: z.string(), rolledBack: z.literal(true), revision: z.number().int().nonnegative() }), signal);
