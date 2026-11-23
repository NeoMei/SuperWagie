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
  idempotencyKey: z.string().min(1), kind: z.enum(['purchase', 'upgrade', 'checkout']),
  accountId: z.string().min(1), productId: z.string(), amount: units,
  offerId: z.string().optional(), resourceId: z.string().optional(),
  walletTopUp: z.literal(true).optional(), provider: z.enum(['wechat', 'alipay']).optional(), quoteId: z.string().optional(), subscriptionId: z.string().optional(),
  status: z.enum(['PREPARED', 'UNKNOWN', 'PENDING', 'APPLIED', 'FAILED']),
  errorCode: z.string().optional(), createdAt: z.string(),
});
const checkoutSchema = z.object({
  id: z.string().min(1), account_id: z.string().min(1), product_id: z.enum(['superwagie', 'llmrouter']), provider: z.enum(['wechat', 'alipay']), offer_name: z.string(), walletTopUp: z.literal(true).optional(), amount: units, currency: z.literal('CNY'),
  payment_status: z.enum(['CREATED', 'PENDING', 'UNKNOWN', 'PAID', 'CLOSED', 'REVIEW']), fulfillment_status: z.enum(['NOT_STARTED', 'PENDING', 'FULFILLED', 'REVIEW']), refund_status: z.enum(['', 'PENDING', 'SUCCEEDED', 'REVIEW', 'REJECTED']),
  close_pending: z.boolean().optional(),
  expires_at: z.iso.datetime(), created_at: z.iso.datetime(), order_id: z.string().optional(), error_code: z.string().optional(),
  upgrade_return_status: z.enum(['UPGRADE_PENDING', 'UPGRADE_RELEASING', 'UPGRADE_RETURNED', 'UPGRADE_REVIEW']).optional(),
  upgrade_refund_amount: units.optional(),
  product_credit_upgrade: z.object({ previous_subscription_id: z.string(), previous_order_id: z.string(), estimated_refund_amount: units, refund_payment_source: z.enum(['wallet', 'external']), applied_credit_amount: units.optional() }).optional(),
  session: z.object({ kind: z.enum(['qr', 'redirect']), url: z.string().min(1).max(16000), expires_at: z.iso.datetime({ offset: true }) }).optional(),
}).refine(({ provider: paymentProvider, session }) => {
  if (!session) return true;
  try {
    const url = new URL(session.url);
    return paymentProvider === 'wechat' ? session.kind === 'qr' && url.protocol === 'weixin:'
      : url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash
        && (session.kind === 'qr'
          ? url.hostname === 'qr.alipay.com' && url.pathname !== '/' && session.url.length <= 1024
          : url.hostname === 'openapi.alipay.com' && url.pathname === '/gateway.do');
  } catch { return false; }
});
export type PlatformCheckout = z.infer<typeof checkoutSchema>;
const renewal = z.object({ enabled: z.boolean(), version: z.number().int().nonnegative() });
const productWalletSchema = z.object({
  version: z.literal('product_v1'), account_id: z.string(), cash: z.object({ asset: z.literal('CNY/6'), available: units }),
  can_manage: z.boolean(), products: z.array(z.object({
    product_id: z.string(), name: z.string(), subscription_renewal: renewal.extend({ offer_name: z.string().optional(), price: units.optional() }),
    addon_renewal: renewal.extend({ offer_id: z.string().optional(), trigger: z.enum(['exhausted', 'threshold']).optional(), threshold: units.optional() }),
    addon_offers: z.array(z.object({ id: z.string(), name: z.string(), price: units })),
    orders: z.array(z.object({ id: z.string(), offer_name: z.string(), amount: units, payment_status: z.string(), fulfillment_status: z.string(), refund_status: z.string(), upgrade_refund_amount: units.optional(), created_at: z.string().datetime({ offset: true }) })),
  })),
});
export type PlatformProductWalletState = z.infer<typeof productWalletSchema>;
type RenewalUpdate = { enabled: boolean; expectedVersion: number } & (
  { kind: 'subscription' } | { kind: 'addon'; offerId?: string; trigger?: 'threshold' | 'exhausted'; threshold?: string });
export const updatePlatformRenewal = (accountId: string, productId: string, input: RenewalUpdate) => requestPlatformAccount(
  `/api/platform-account/commerce/product-wallet/${encodeURIComponent(productId)}/renewal`,
  productWalletSchema, 'PUT', JSON.stringify({ accountId, ...input }),
);
const commerceSchema = z.object({
  productCreditWallet: z.literal(true).optional(), productWallet: productWalletSchema.nullable().optional(),
  accountId: z.string().min(1), role: z.string(), financialAccess: z.boolean(), missingScopes: z.array(z.string()),
  payments: z.object({ mode: z.enum(['unconfigured', 'external']), canPurchase: z.boolean(), canTopUp: z.boolean().optional(), providers: z.array(z.enum(['wechat', 'alipay'])).optional() }),
  wallets: z.array(walletSchema).nullable(), offers: z.array(offerSchema).nullable(), orders: z.array(orderSchema).nullable(),
  checkouts: z.array(checkoutSchema).optional(), intents: z.array(intentSchema),
});
export type PlatformCommerceState = z.infer<typeof commerceSchema>;
const checkoutIntentSchema = intentSchema.extend({ checkout: checkoutSchema.optional() }).refine((intent) =>
  !intent.checkout || (intent.kind === 'checkout' && intent.checkout.id === intent.resourceId
    && intent.checkout.account_id === intent.accountId && intent.checkout.product_id === intent.productId
    && intent.checkout.provider === intent.provider && intent.checkout.amount === intent.amount && intent.checkout.walletTopUp === intent.walletTopUp));
export type PlatformCommerceIntent = z.infer<typeof checkoutIntentSchema>;
const upgradeQuoteSchema = z.object({
  paymentSource: z.enum(['wallet', 'external']).optional(), roundingRule: z.literal('cny_cent_ceil_v1').optional(), originalAmount: units.optional(),
  id: z.string().min(1), accountId: z.string().min(1), subscriptionId: z.string().min(1),
  subscriptionVersion: z.number().int().nonnegative(), offer: offerSchema, amount: units, additionalCredits: units,
  productCreditUpgrade: z.object({ previousOrderId: z.string().min(1), estimatedRefundAmount: units, refundPaymentSource: z.enum(['wallet', 'external']), appliedCreditAmount: units.optional() }).optional(),
  periodStart: z.iso.datetime(), expiresAt: z.iso.datetime(), createdAt: z.iso.datetime(),
});
export type PlatformUpgradeQuote = z.infer<typeof upgradeQuoteSchema>;
export const createPlatformCheckout = (input: { accountId: string; offerId?: string; quoteId?: string; amount?: string; provider: 'wechat' | 'alipay'; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/checkouts', checkoutIntentSchema, 'POST', JSON.stringify(input));
export const updatePlatformCheckout = (accountId: string, id: string, action: 'reconcile' | 'close' | 'refund') => requestPlatformAccount(`/api/platform-account/commerce/checkouts/${encodeURIComponent(id)}/${action}`, checkoutSchema, 'POST', JSON.stringify({ accountId }));
export const readPlatformCommerce = (summary = false) => requestPlatformAccount(summary ? '/api/platform-account/commerce?summary=1' : '/api/platform-account/commerce', commerceSchema);
export const readPlatformOrders = (accountId: string) => requestPlatformAccount(`/api/platform-account/commerce/orders?accountId=${encodeURIComponent(accountId)}`, z.array(orderSchema));
export const purchasePlatformOffer = (input: { accountId: string; offerId: string; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/purchases', intentSchema, 'POST', JSON.stringify(input));
export const createPlatformUpgradeQuote = (input: { accountId: string; subscriptionId: string; offerId: string; paymentSource?: 'wallet' | 'external' }) => requestPlatformAccount('/api/platform-account/commerce/upgrade-quotes', upgradeQuoteSchema, 'POST', JSON.stringify(input));
export const acceptPlatformUpgradeQuote = (input: { accountId: string; quoteId: string; idempotencyKey: string }) => requestPlatformAccount('/api/platform-account/commerce/upgrade-purchases', intentSchema, 'POST', JSON.stringify(input));
export const reconcilePlatformIntent = (accountId: string, key: string) => requestPlatformAccount(`/api/platform-account/commerce/intents/${encodeURIComponent(key)}/reconcile`, intentSchema, 'POST', JSON.stringify({ accountId }));

/** Product credit expiry dates use the same calendar as UniHub fulfillment. */
export const formatProductBillingDate = (value: string, locale: string): string =>
  new Date(value).toLocaleDateString(locale, { timeZone: 'Asia/Shanghai' });

/** Cash uses CNY/6; retain ledger precision while always showing whole cents. */
export const formatPlatformMoney = (value: string): string => {
  if (!units.safeParse(value).success) throw new PlatformAccountError('platform_response_invalid');
  const amount = BigInt(value);
  const fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${amount / 1_000_000n}.${fraction}`;
};

/** Point summaries show whole spendable points without overstating a balance. */
export const formatPlatformPoints = (value: string): string => {
  if (!units.safeParse(value).success) throw new PlatformAccountError('platform_response_invalid');
  return String(BigInt(value) / 1_000_000n);
};

