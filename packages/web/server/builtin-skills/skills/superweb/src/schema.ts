import { z } from 'zod';

export const STAGES = [
  'brief',
  'direction',
  'sample',
  'full',
  'acceptance',
  'delivered',
] as const;

export const ROUTES = ['page', 'app'] as const;
export const GATES = ['direction', 'sample', 'acceptance'] as const;

export type Stage = (typeof STAGES)[number];
export type Route = (typeof ROUTES)[number];
export type Gate = (typeof GATES)[number];

const timestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO timestamp');

export const DecisionSchema = z
  .object({
    id: z.string().min(1),
    gate: z.enum(GATES),
    revision: z.number().int().positive(),
    choice: z.string().min(1),
    at: timestamp,
    target: z.enum(['full', 'sample']).optional(),
    acknowledgedIssues: z.boolean().optional(),
  })
  .strict();

export const AcceptanceSchema = z
  .object({
    passed: z.boolean(),
    reportPath: z.string().min(1).optional(),
    screenshots: z.array(z.string().min(1)).optional(),
    browserAvailable: z.boolean().optional(),
    issueCount: z.number().int().nonnegative().optional(),
    previewHash: z.string().min(1).optional(),
    checkedAt: timestamp.optional(),
  })
  .strict();

export const ArtifactsSchema = z
  .object({
    brief: z.string().min(1).optional(),
    directions: z.string().min(1).optional(),
    guide: z.string().min(1).optional(),
    copy: z.string().min(1).optional(),
    sample: z.string().min(1).optional(),
    preview: z.string().min(1).optional(),
    delivery: z.string().min(1).optional(),
  })
  .strict();

export const SuperwebStateSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().min(1),
    route: z.enum(ROUTES),
    stage: z.enum(STAGES),
    stageRevision: z.number().int().positive(),
    briefPath: z.string().min(1),
    selectedDirectionId: z.string().min(1).nullable(),
    decisions: z.array(DecisionSchema),
    artifacts: ArtifactsSchema,
    acceptance: AcceptanceSchema,
  })
  .strict();

export type SuperwebState = z.infer<typeof SuperwebStateSchema>;
export type SuperwebDecision = z.infer<typeof DecisionSchema>;

export class StateError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'StateError';
    this.hint = hint;
  }
}

export function parseState(value: unknown): SuperwebState {
  const parsed = SuperwebStateSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new StateError(`superweb.json 不符合状态 schema：${detail}`, '修复 superweb.json，或重新 start 一个任务；不会自动重置。');
  }
  return parsed.data;
}
