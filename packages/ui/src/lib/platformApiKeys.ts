import { z } from 'zod';
import { requestPlatformAccount } from './platformAccount';
import { modelPurposeIdSchema } from './modelConfiguration';

const timestamp = z.iso.datetime({ offset: true });
const modelTestSchema = z.object({
  id: z.string().min(1),
  purpose: modelPurposeIdSchema,
  modelId: z.string().min(1).nullable(),
  status: z.enum(['queued', 'testing', 'verified', 'failed', 'unknown', 'skipped']),
  applied: z.boolean().default(false),
  testedAt: timestamp.nullable(),
  errorCode: z.string().nullable(),
}).refine((result) => result.status !== 'verified' || Boolean(result.modelId && result.testedAt));
const setupStateSchema = z.object({
  accountId: z.string().min(1),
  enterpriseMode: z.boolean(),
  activation: z.object({
    operationId: z.string().min(1),
    status: z.enum(['issuing', 'configuring', 'testing', 'ready', 'failed', 'unknown', 'interrupted']),
    stage: z.enum(['issue', 'configure', 'test']),
    key: z.object({ id: z.string().min(1), last4: z.string().min(1).max(4), createdAt: timestamp, expiresAt: timestamp.nullable() }).nullable(),
    modelId: z.string().nullable(),
    connectionId: z.string().nullable(),
    providerId: z.string().nullable(),
    test: z.object({ status: z.enum(['verified', 'failed', 'unknown']), testedAt: timestamp.nullable(), errorCode: z.string().nullable() }).nullable(),
    testRunId: z.string().min(1).nullable().default(null),
    tests: z.array(modelTestSchema).refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length).default([]),
    errorCode: z.string().nullable(),
    actions: z.array(z.enum(['resume', 'retest'])),
  }).nullable(),
});

export type PlatformAccountKeySetupState = z.infer<typeof setupStateSchema>;
export type PlatformAccountKeySetupAction = 'activate' | 'resume' | 'retest';
const path = '/api/model-configuration/bootstrap/account-key';
const schemaForAccount = (accountId: string) => setupStateSchema.refine((result) => result.accountId === accountId);

export const readPlatformAccountKeySetup = (accountId: string) => requestPlatformAccount(
  `${path}?accountId=${encodeURIComponent(accountId)}`, schemaForAccount(accountId),
);
export const runPlatformAccountKeySetup = (accountId: string, action: PlatformAccountKeySetupAction) => requestPlatformAccount(
  path, schemaForAccount(accountId), 'POST', JSON.stringify({ accountId, action }),
);
