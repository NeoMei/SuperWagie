import { z } from 'zod';

const productId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const id = z.string().min(1).max(200);
const units = z.string().regex(/^(0|[1-9]\d*)$/);
const date = z.string().datetime({ offset: true });
const version = z.number().int().nonnegative();
const trigger = z.enum(['exhausted', 'threshold']);
const renewalKind = z.enum(['subscription', 'addon']);
const renewal = z.object({ enabled: z.boolean(), version });
const subscriptionRenewal = renewal.extend({ offer_name: id.optional(), price: units.optional() });
const addonRenewal = renewal.extend({ offer_id: id.optional(), trigger: trigger.optional(), threshold: units.optional() });
const order = z.object({ id, offer_name: id, amount: units, payment_status: id, fulfillment_status: id, refund_status: z.string(), created_at: date });
const addonOffer = z.object({ id, name: id, price: units });

export const PRODUCT_WALLET_VERSION = 'product_v1';
export const productWalletHeaders = (init) => ({ ...init, headers: { ...init?.headers, 'X-UniHub-Product-Credit-Wallet': PRODUCT_WALLET_VERSION } });
export const productWalletCapability = z.object({ product_id: z.literal('superwagie').optional(), product_credit_wallet: z.boolean().optional() })
  .refine((value) => value.product_credit_wallet !== true || value.product_id === 'superwagie');
export const productWalletSchema = z.object({
  version: z.literal(PRODUCT_WALLET_VERSION),
  account_id: id,
  cash: z.object({ asset: z.literal('CNY/6'), available: units }),
  products: z.array(z.object({
    product_id: productId, name: id, subscription_renewal: subscriptionRenewal,
    addon_renewal: addonRenewal, orders: z.array(order), addon_offers: z.array(addonOffer),
  })),
  can_manage: z.boolean(),
}).refine((value) => new Set(value.products.map((item) => item.product_id)).size === value.products.length);

export const productRenewalInput = z.object({
  accountId: id, kind: renewalKind, enabled: z.boolean(), expectedVersion: version,
  offerId: id.optional(), trigger: trigger.optional(), threshold: units.optional(),
}).strict().refine((value) => {
  const hasAddonFields = value.offerId !== undefined || value.trigger !== undefined || value.threshold !== undefined;
  if (value.kind === 'subscription' || !value.enabled) return !hasAddonFields;
  if (!value.offerId || !value.trigger) return false;
  return value.trigger === 'threshold' ? value.threshold !== undefined && value.threshold !== '0' : value.threshold === undefined;
});
export const walletProductId = productId;

const batch = z.object({
  id, available: units, reserved: units, starts_at: date, expires_at: date, frozen: z.boolean(),
  kind: z.enum(['subscription', 'addon']), source_scope: z.literal('product'), product_id: z.literal('superwagie'),
});
export const ownProductCreditsSchema = z.object({
  product_id: z.literal('superwagie'), credit_scope: z.literal(PRODUCT_WALLET_VERSION),
  available: units, reserved: units, active_membership: z.boolean(), membership_paid_through: date.nullish(),
  batches: z.array(batch),
}).refine((value) => value.active_membership || value.available === '0');
