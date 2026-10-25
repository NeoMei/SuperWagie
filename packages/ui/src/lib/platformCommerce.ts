import { z } from 'zod';
import { PlatformAccountError, requestPlatformAccount } from '@/lib/platformAccount';

const units = z.string().regex(/^(0|[1-9]\d*)$/);
const walletSchema = z.object({ productId: z.string(), asset: z.literal('CNY/6'), amount: units });
const offerSchema = z.object({
  id: z.string().min(1), productId: z.string(), name: z.string(), accountKind: z.string(),
  kind: z.enum(['membership', 'addon']), period: z.string(), price: units, monthlyCredit: units,
  validityMonths: z.number().int().nonnegative(), rank: z.number().int().nonnegative(), sandbox: z.boolean(),
});
const orderSchema = z.object({
  id: z.string().min(1), productId: z.string(), offerName: z.string(), amount: units,
  paymentStatus: z.string(), fulfillmentStatus: z.string(), refundStatus: z.string(),
});
const intentSchema = z.object({
  idempotencyKey: z.string().min(1), kind: z.enum(['recharge', 'purchase']),
  accountId: z.string().min(1), productId: z.string(), amount: units,
  offerId: z.string().optional(), resourceId: z.string().optional(),
  status: z.enum(['PREPARED', 'UNKNOWN', 'PENDING', 'APPLIED', 'FAILED']),
  errorCode: z.string().optional(), createdAt: z.string(),
});
const commerceSchema = z.object({
  accountId: z.string().min(1), role: z.string(), financialAccess: z.boolean(), missingScopes: z.array(z.string()),
  payments: z.object({ mode: z.enum(['sandbox', 'unconfigured']), canRecharge: z.boolean(), canPurchase: z.boolean() }),
  wallets: z.array(walletSchema).nullable(), offers: z.array(offerSchema).nullable(), orders: z.array(orderSchema).nullable(),
  intents: z.array(intentSchema), rechargeHistoryScope: z.literal('this-instance'),
});
export type PlatformCommerceState = z.infer<typeof commerceSchema>;
export type PlatformCommerceIntent = z.infer<typeof intentSchema>;
export const readPlatformCommerce = () => requestPlatformAccount('/api/platform-account/commerce', commerceSchema);
export const createPlatformRecharge = (input: { accountId: string; productId: string; amount: string; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/recharges', intentSchema, 'POST', JSON.stringify(input));
export const purchasePlatformOffer = (input: { accountId: string; offerId: string; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/purchases', intentSchema, 'POST', JSON.stringify(input));
export const reconcilePlatformIntent = (accountId: string, key: string) => requestPlatformAccount(`/api/platform-account/commerce/intents/${encodeURIComponent(key)}/reconcile`, intentSchema, 'POST', JSON.stringify({ accountId }));
export const settlePlatformSandboxRecharge = (accountId: string, key: string) => requestPlatformAccount(`/api/platform-account/commerce/intents/${encodeURIComponent(key)}/sandbox-settle`, intentSchema, 'POST', JSON.stringify({ accountId }));

/** Cash uses CNY/6; retain ledger precision while always showing whole cents. */
export const formatPlatformMoney = (value: string): string => {
  if (!units.safeParse(value).success) throw new PlatformAccountError('platform_response_invalid');
  const amount = BigInt(value);
  const fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${amount / 1_000_000n}.${fraction}`;
};

/** External recharge accepts positive whole cents, without floating-point arithmetic. */
export const parsePlatformRechargeAmount = (input: string): string => {
  if (!/^(0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(input)) throw new PlatformAccountError('platform_amount_invalid');
  const [whole, fraction = ''] = input.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new PlatformAccountError('platform_amount_invalid');
  return amount.toString();
};
