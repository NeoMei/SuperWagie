import { z } from 'zod';
import { requestPlatformAccount } from './platformAccount';
import { modelPurposeIdSchema } from './modelConfiguration';

const fundingModeSchema = z.enum(['credits', 'prepaid_cash']);
export type PlatformKeyFundingMode = z.infer<typeof fundingModeSchema>;
const timestamp = z.iso.datetime({ offset: true });
const modelTestSchema = z.object({
  id: z.string().min(1),
  purpose: modelPurposeIdSchema,
  modelId: z.string().min(1).nullable(),
  status: z.enum(['queued', 'testing', 'verified', 'failed', 'unknown', 'skipped']),
  applied: z.boolean().default(false),
  testedAt: timestamp.nullable(),
  errorCode: z.string().nullable(),
  applicationError: z.object({ status: z.enum(['failed', 'unknown']), errorCode: z.string().min(1) }).optional(),
}).refine((result) => (result.status !== 'verified' || Boolean(result.modelId && result.testedAt))
  && (!result.applicationError || result.status === 'verified' && !result.applied));
const setupStateSchema = z.object({
  accountId: z.string().min(1),
  enterpriseMode: z.boolean(),
  fundingMode: fundingModeSchema.optional(),
  nativeCredits: z.object({ ready: z.boolean(), reason: z.string().optional() }).optional(),
  activation: z.object({
    operationId: z.string().min(1),
    fundingMode: fundingModeSchema.optional(),
    pricingSource: z.enum(['llmrouter_native', 'llmrouter_native_credit']).optional(),
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
type PlatformAccountKeySetupInput = { accountId: string; action: PlatformAccountKeySetupAction; fundingMode?: PlatformKeyFundingMode };
const path = '/api/model-configuration/bootstrap/account-key';
const schemaForAccount = (accountId: string, fundingMode?: PlatformKeyFundingMode) => setupStateSchema.refine((result) => result.accountId === accountId
  && (fundingMode !== 'credits' || result.fundingMode === 'credits'));

export const readPlatformAccountKeySetup = (accountId: string, fundingMode?: PlatformKeyFundingMode) => requestPlatformAccount(
  `${path}?accountId=${encodeURIComponent(accountId)}${fundingMode ? `&fundingMode=${fundingMode}` : ''}`, schemaForAccount(accountId, fundingMode),
);
export const runPlatformAccountKeySetup = (accountId: string, action: PlatformAccountKeySetupAction, fundingMode?: PlatformKeyFundingMode) => {
  const input: PlatformAccountKeySetupInput = { accountId, action };
  if (fundingMode) input.fundingMode = fundingMode;
  return requestPlatformAccount(path, schemaForAccount(accountId, fundingMode), 'POST', JSON.stringify(input));
};
