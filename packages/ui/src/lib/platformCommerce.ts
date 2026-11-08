import { z } from 'zod';
import { PlatformAccountError, requestPlatformAccount } from '@/lib/platformAccount';

const units = z.string().regex(/^(0|[1-9]\d*)$/);
const walletSchema = z.object({ productId: z.string(), asset: z.literal('CNY/6'), amount: units });
const salesReadinessSchema = z.discriminatedUnion('ready', [
  z.object({ ready: z.literal(true) }),
  z.object({ ready: z.literal(false), reason: z.literal('credit_rates_unavailable') }),
]);
const offerSchema = z.object({
  salesReadiness: salesReadinessSchema.optional(),
  id: z.string().min(1), productId: z.string(), name: z.string(), accountKind: z.string(),
  kind: z.enum(['membership', 'addon']), period: z.string(), price: units, monthlyCredit: units,
  validityMonths: z.number().int().nonnegative(), rank: z.number().int().nonnegative(), sandbox: z.boolean(),
  pricingProgram: z.string().optional(),
  purchaseReadiness: z.discriminatedUnion('ready', [z.object({ ready: z.literal(true) }), z.object({ ready: z.literal(false), reason: z.literal('points_runtime_unavailable') })]).optional(),
});
const orderSchema = z.object({
  id: z.string().min(1), productId: z.string(), offerName: z.string(), amount: units,
  paymentStatus: z.string(), fulfillmentStatus: z.string(), refundStatus: z.string(),
});
const intentSchema = z.object({
  idempotencyKey: z.string().min(1), kind: z.enum(['recharge', 'purchase', 'upgrade', 'checkout']),
  accountId: z.string().min(1), productId: z.string(), amount: units,
  offerId: z.string().optional(), resourceId: z.string().optional(),
  provider: z.enum(['wechat', 'alipay']).optional(), quoteId: z.string().optional(), subscriptionId: z.string().optional(),
  status: z.enum(['PREPARED', 'UNKNOWN', 'PENDING', 'APPLIED', 'FAILED']),
  errorCode: z.string().optional(), createdAt: z.string(),
});
const checkoutSchema = z.object({
  id: z.string().min(1), account_id: z.string().min(1), product_id: z.enum(['superwagie', 'llmrouter']), provider: z.enum(['wechat', 'alipay']), offer_name: z.string(), amount: units, currency: z.literal('CNY'),
  payment_status: z.enum(['CREATED', 'PENDING', 'UNKNOWN', 'PAID', 'CLOSED', 'REVIEW']), fulfillment_status: z.enum(['NOT_STARTED', 'PENDING', 'FULFILLED', 'REVIEW']), refund_status: z.enum(['', 'PENDING', 'SUCCEEDED', 'REVIEW', 'REJECTED']),
  expires_at: z.iso.datetime(), created_at: z.iso.datetime(), order_id: z.string().optional(), error_code: z.string().optional(),
  session: z.object({ kind: z.enum(['qr', 'redirect']), url: z.string().min(1).max(16000), expires_at: z.iso.datetime() }).optional(),
}).refine((checkout) => {
  if (!checkout.session) return true;
  try {
    const url = new URL(checkout.session.url);
    return checkout.provider === 'wechat' ? checkout.session.kind === 'qr' && url.protocol === 'weixin:'
      : checkout.session.kind === 'redirect' && url.protocol === 'https:' && url.hostname === 'openapi.alipay.com' && url.pathname === '/gateway.do' && !url.port && !url.username && !url.password;
  } catch { return false; }
});
export type PlatformCheckout = z.infer<typeof checkoutSchema>;
const commerceSchema = z.object({
  accountId: z.string().min(1), role: z.string(), financialAccess: z.boolean(), missingScopes: z.array(z.string()),
  payments: z.object({ mode: z.enum(['sandbox', 'unconfigured', 'external']), canRecharge: z.boolean(), canPurchase: z.boolean(), providers: z.array(z.enum(['wechat', 'alipay'])).optional() }),
  wallets: z.array(walletSchema).nullable(), offers: z.array(offerSchema).nullable(), orders: z.array(orderSchema).nullable(),
  checkouts: z.array(checkoutSchema).optional(), intents: z.array(intentSchema), rechargeHistoryScope: z.literal('this-instance'),
});
export type PlatformCommerceState = z.infer<typeof commerceSchema>;
export type PlatformCommerceIntent = z.infer<typeof intentSchema>;
const upgradeQuoteSchema = z.object({
  paymentSource: z.enum(['wallet', 'external']).optional(), roundingRule: z.literal('cny_cent_ceil_v1').optional(), originalAmount: units.optional(),
  id: z.string().min(1), accountId: z.string().min(1), subscriptionId: z.string().min(1),
  subscriptionVersion: z.number().int().nonnegative(), offer: offerSchema, amount: units, additionalCredits: units,
  periodStart: z.iso.datetime(), expiresAt: z.iso.datetime(), createdAt: z.iso.datetime(),
});
export type PlatformUpgradeQuote = z.infer<typeof upgradeQuoteSchema>;
export const createPlatformCheckout = (input: { accountId: string; offerId?: string; quoteId?: string; provider: 'wechat' | 'alipay'; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/checkouts', intentSchema, 'POST', JSON.stringify(input));
export const updatePlatformCheckout = (accountId: string, id: string, action: 'reconcile' | 'close' | 'refund') => requestPlatformAccount(`/api/platform-account/commerce/checkouts/${encodeURIComponent(id)}/${action}`, checkoutSchema, 'POST', JSON.stringify({ accountId }));
export const readPlatformCommerce = () => requestPlatformAccount('/api/platform-account/commerce', commerceSchema);
export const createPlatformRecharge = (input: { accountId: string; productId: string; amount: string; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/recharges', intentSchema, 'POST', JSON.stringify(input));
export const purchasePlatformOffer = (input: { accountId: string; offerId: string; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/purchases', intentSchema, 'POST', JSON.stringify(input));
export const createPlatformUpgradeQuote = (input: { accountId: string; subscriptionId: string; offerId: string; paymentSource?: 'wallet' | 'external' }) => requestPlatformAccount('/api/platform-account/commerce/upgrade-quotes', upgradeQuoteSchema, 'POST', JSON.stringify(input));
export const acceptPlatformUpgradeQuote = (input: { accountId: string; quoteId: string; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/upgrade-purchases', intentSchema, 'POST', JSON.stringify(input));
export const reconcilePlatformIntent = (accountId: string, key: string) => requestPlatformAccount(`/api/platform-account/commerce/intents/${encodeURIComponent(key)}/reconcile`, intentSchema, 'POST', JSON.stringify({ accountId }));
export const settlePlatformSandboxRecharge = (accountId: string, key: string) => requestPlatformAccount(`/api/platform-account/commerce/intents/${encodeURIComponent(key)}/sandbox-settle`, intentSchema, 'POST', JSON.stringify({ accountId }));

/** Cash uses CNY/6; retain ledger precision while always showing whole cents. */
export const formatPlatformMoney = (value: string): string => {
  if (!units.safeParse(value).success) throw new PlatformAccountError('platform_response_invalid');
  const amount = BigInt(value);
  const fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${amount / 1_000_000n}.${fraction}`;
};

/** Point summaries retain micro-point precision without padding whole values. */
export const formatPlatformPoints = (value: string): string => {
  if (!units.safeParse(value).success) throw new PlatformAccountError('platform_response_invalid');
  const amount = BigInt(value);
  const fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
};

/** External recharge accepts positive whole cents, without floating-point arithmetic. */
export const parsePlatformRechargeAmount = (input: string): string => {
  if (!/^(0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(input)) throw new PlatformAccountError('platform_amount_invalid');
  const [whole, fraction = ''] = input.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n) throw new PlatformAccountError('platform_amount_invalid');
  return amount.toString();
};
