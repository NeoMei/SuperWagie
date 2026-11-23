import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PlatformAccountError } from './runtime.js';
import { openCommerceStore, refundReasonSchema } from './commerce-store.js';
import { PRODUCT_WALLET_VERSION, productRenewalInput, productWalletHeaders, productWalletSchema, walletProductId } from './product-wallet.js';

const id = z.string().min(1).max(200);
const units = z.string().regex(/^(0|[1-9]\d*)$/);
const product = z.enum(['superwagie', 'llmrouter']);
const key = z.string().uuid();
const accountInput = z.object({ accountId: id }).strict();
const purchaseInput = accountInput.extend({ offerId: id, idempotencyKey: key });
const quoteInput = accountInput.extend({ subscriptionId: id, offerId: id, paymentSource: z.enum(['wallet', 'external']).default('wallet') });
const checkoutInput = accountInput.extend({
  offerId: id.optional(), quoteId: id.optional(), amount: units.regex(/^[1-9]\d{0,11}0000$/).refine((value) => BigInt(value) <= 1_000_000_000_000_000n).optional(),
  provider: z.enum(['wechat', 'alipay']), idempotencyKey: key,
}).refine((value) => [value.offerId, value.quoteId, value.amount].filter(Boolean).length === 1);
const upgradeInput = accountInput.extend({ quoteId: id, idempotencyKey: key });
const accountsSchema = z.array(z.object({ id, kind: z.enum(['personal', 'team']), role: z.string() }));
const capabilitySchema = z.object({ product_id: z.literal('superwagie'), scopes: z.array(z.string()), sandbox: z.boolean(), product_wallet_recharge: z.boolean(), product_credit_wallet: z.boolean().optional(), real_payments_configured: z.boolean(), payment_providers: z.array(z.enum(['wechat', 'alipay'])).optional(), alipay_checkout_qr: z.boolean().optional(), native_credits: z.object({ ready: z.boolean() }).optional() });
const walletSchema = z.object({ product_id: z.string(), asset: z.literal('CNY/6'), amount: units });
const subscriptionsSchema = z.array(z.object({ product_id: z.string(), status: z.string(), paid_through: z.string().datetime() }));
const resourcesSchema = z.object({ account_id: id, wallets: z.array(walletSchema).optional(), as_of: z.string() });
const salesReadinessSchema = z.discriminatedUnion('ready', [
  z.object({ ready: z.literal(true) }),
  z.object({ ready: z.literal(false), reason: z.literal('credit_rates_unavailable') }),
]);
const offerSchema = z.object({
  sales_readiness: salesReadinessSchema.optional(),
  id, product_id: z.string(), credit_scope: z.string().optional(), name: z.string(), account_kind: z.enum(['personal', 'team', 'both']),
  kind: z.enum(['membership', 'addon']), period: z.string(), price: units, monthly_credit: units,
  validity_months: z.number().int().nonnegative(), rank: z.number().int().nonnegative(), sandbox: z.boolean(), status: z.string(),
  entitlements: z.object({ pricing_program: z.string().optional() }).nullish().transform((value) => value ?? undefined),
});
const upgradeSourceSchema = z.object({
  previous_subscription_id: id, previous_order_id: id, previous_version: z.number().int().nonnegative().optional(),
  estimated_refund_amount: units, refund_payment_source: z.enum(['wallet', 'external']), applied_credit_amount: units.optional(),
});
const orderSchema = z.object({
  id, account_id: id, actor_id: id, product_id: z.string(), offer: offerSchema, amount: units,
  payment_status: z.string(), fulfillment_status: z.string(), refund_status: z.string().optional(),
  kind: z.string().optional(), subscription_id: id.optional(), product_credit_upgrade: upgradeSourceSchema.optional(),
});
const quoteSchema = z.object({
  payment_source: z.enum(['wallet', 'external']).optional(), rounding_rule: z.literal('cny_cent_ceil_v1').optional(), original_amount: units.optional(),
  id, account_id: id, subscription_id: id, subscription_version: z.number().int().nonnegative(),
  offer: offerSchema, amount: units, grant_amount: units,
  product_credit_upgrade: upgradeSourceSchema.optional(),
  period_start: z.string().datetime(), expires_at: z.string().datetime(), created_at: z.string().datetime(),
});
const checkoutSession = z.object({ kind: z.enum(['qr', 'redirect']), url: z.string().min(1).max(16000), expires_at: z.string().datetime({ offset: true }) });
const checkoutSchema = z.object({
  id, account_id: id, product_id: product, provider: z.enum(['wechat', 'alipay']), offer_name: z.string(), walletTopUp: z.literal(true).optional(), amount: units, currency: z.literal('CNY'),
  payment_status: z.enum(['CREATED', 'PENDING', 'UNKNOWN', 'PAID', 'CLOSED', 'REVIEW']), fulfillment_status: z.enum(['NOT_STARTED', 'PENDING', 'FULFILLED', 'REVIEW']), refund_status: z.enum(['', 'PENDING', 'SUCCEEDED', 'REVIEW', 'REJECTED']).default(''),
  close_pending: z.boolean().optional(),
  expires_at: z.string().datetime(), created_at: z.string().datetime(), order_id: id.optional(), error_code: z.string().optional(),
  subscription_id: id.optional(), product_credit_upgrade: upgradeSourceSchema.optional(),
  upgrade_return_status: z.enum(['UPGRADE_PENDING', 'UPGRADE_RELEASING', 'UPGRADE_RETURNED', 'UPGRADE_REVIEW']).optional(), upgrade_refund_amount: units.optional(),
  session: checkoutSession.optional(),
}).superRefine((value, ctx) => {
  if (!value.session) return;
  try {
    const url = new URL(value.session.url);
    const valid = value.provider === 'wechat' ? value.session.kind === 'qr' && url.protocol === 'weixin:'
      : url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash
        && (value.session.kind === 'qr'
          ? url.hostname === 'qr.alipay.com' && url.pathname !== '/' && value.session.url.length <= 1024
          : url.hostname === 'openapi.alipay.com' && url.pathname === '/gateway.do');
    if (!valid) ctx.addIssue({ code: 'custom', message: 'Invalid provider session' });
  } catch { ctx.addIssue({ code: 'custom', message: 'Invalid provider session' }); }
});
const cashCheckoutSchema = z.object({
  id: z.string().regex(/^ct_[A-Za-z0-9]{1,32}$/), account_id: id, product_id: z.literal('superwagie'), wallet_target: z.string().optional(),
  provider: z.enum(['wechat', 'alipay']), amount: units, currency: z.literal('CNY'), payment_status: z.string(),
  expires_at: z.string().datetime(), created_at: z.string().datetime(), session: checkoutSession.optional(),
  credit_status: z.string().optional(), error_code: z.string().optional(), close_pending: z.boolean().optional(),
});
const checkoutListSchema = z.array(z.object({ account_id: id, product_id: walletProductId }).passthrough());
const cashToCheckout = (record) => ({
  ...record, walletTopUp: true, offer_name: '', refund_status: '',
  fulfillment_status: record.credit_status === 'APPLIED' ? 'FULFILLED' : record.payment_status === 'PAID' ? 'PENDING' : 'NOT_STARTED',
});
const requiredScopes = ['catalog:read', 'subscriptions:read', 'wallets:read', 'orders:read', 'orders:write'];
const fail = (code, status = 400) => { throw new PlatformAccountError(code, status); };
const parse = (schema, value, code = 'platform_response_invalid') => {
  const result = schema.safeParse(value);
  if (!result.success) fail(code, code === 'platform_request_invalid' ? 400 : 502);
  return result.data;
};
const parseListedCheckouts = (raw, schema, accountId) => {
  const rows = parse(checkoutListSchema, raw);
  if (rows.some((row) => row.account_id !== accountId)) fail('platform_response_invalid', 502);
  return rows.filter((row) => schema.shape.product_id.safeParse(row.product_id).success).map((row) => parse(schema, row));
};
const segment = (value) => encodeURIComponent(value);
const pathFor = (accountId, suffix) => `/v1/accounts/${segment(accountId)}/${suffix}`;
const checkoutProviders = (capabilities) => (capabilities.real_payments_configured !== true ? [] : capabilities.payment_providers ?? [])
  .filter((provider) => provider !== 'alipay' || capabilities.alipay_checkout_qr === true);
const requestCheckout = (ctx, suffix, init, useProductWallet) => versionRequest(ctx, pathFor(ctx.account.id, suffix),
  ctx.capabilities.alipay_checkout_qr === true ? { ...init, headers: { ...init?.headers, 'X-UniHub-Alipay-QR': '1' } } : init, useProductWallet);
const versioned = (ctx) => ctx.capabilities.product_credit_wallet === true;
const versionRequest = (ctx, path, init, useProductWallet = versioned(ctx)) => ctx.session.request(path, useProductWallet ? productWalletHeaders(init) : init);
const upgradeHeaders = (negotiated) => ({ 'Content-Type': 'application/json', ...(negotiated && { 'X-UniHub-Legacy-Net-Upgrade': '1' }) });
const hasScopes = (caps, names) => names.every((scope) => caps.scopes.includes(scope));
const financialRole = (role) => role === 'owner' || role === 'billing_admin';
const supportedOffer = (offer, useProductWallet) => useProductWallet
  ? offer.product_id === 'superwagie' && offer.credit_scope === PRODUCT_WALLET_VERSION
  : offer.credit_scope !== PRODUCT_WALLET_VERSION && (offer.product_id === 'superwagie' || (offer.product_id === 'llmrouter' && offer.kind === 'addon'));
const pointsRuntimeUnavailable = (pricingProgram, capabilities) => pricingProgram === 'superwagie-ai-points-v1' && capabilities?.native_credits?.ready !== true;
const publicOffer = (offer, capabilities) => ({ id: offer.id, productId: offer.product_id, name: offer.name, accountKind: offer.account_kind, kind: offer.kind, period: offer.period, price: offer.price, monthlyCredit: offer.monthly_credit, validityMonths: offer.validity_months, rank: offer.rank, sandbox: offer.sandbox, salesReadiness: offer.sales_readiness, pricingProgram: offer.entitlements?.pricing_program, purchaseReadiness: pointsRuntimeUnavailable(offer.entitlements?.pricing_program, capabilities) ? { ready: false, reason: 'points_runtime_unavailable' } : { ready: true } });
const publicOrder = (order) => ({ id: order.id, productId: order.product_id, offerName: order.offer.name, amount: order.amount, paymentStatus: order.payment_status, fulfillmentStatus: order.fulfillment_status, refundStatus: order.refund_status ?? '' });
const publicIntent = (intent) => ({ idempotencyKey: intent.idempotencyKey, kind: intent.kind, accountId: intent.accountId, productId: intent.productId, amount: intent.amount, offerId: intent.offerId, resourceId: intent.resourceId, quoteId: intent.quoteId, provider: intent.provider, walletTopUp: intent.walletTopUp, subscriptionId: intent.subscriptionId, status: intent.status, errorCode: intent.errorCode, createdAt: intent.createdAt, checkout: intent.checkout });
const intentId = (session, accountId, idempotencyKey) => crypto.createHash('sha256').update(JSON.stringify([session.serviceId, session.actingUserId, accountId, idempotencyKey])).digest('hex');
const safeError = (error) => error instanceof PlatformAccountError && /^[a-z][a-z0-9_]{0,100}$/.test(error.code) ? error.code : 'platform_commerce_unavailable';
const rejectedCodes = new Set(['invalid_request', 'forbidden', 'insufficient_funds', 'insufficient_credits', 'not_found', 'unsupported_plan_change', 'subscription_required', 'payment_not_configured']);
// UniHub emits operation_pending from its pre-admission commercial check
// before a checkout record or provider session exists. A failed create leaves
// no resource to reconcile, so holding the account open forever cannot
// protect a payment that was never admitted. Limit that hold to a short
// safety window for a late duplicate of an already admitted request.
const preAdmissionHoldMs = 60_000;
const releasablePreAdmissionIntent = (intent, at = Date.now()) => intent.kind === 'checkout' && !intent.resourceId && intent.status === 'UNKNOWN' && intent.errorCode === 'operation_pending' && at - Date.parse(intent.updatedAt) >= preAdmissionHoldMs;

/** UniHub remains the authority for balances and fulfillment. Only recovery intent is local. */
export const createPlatformCommerceRuntime = ({ accountRuntime, dataDir, now = Date.now }) => {
  let storePromise;
  let closing = false;
  const active = new Map();
  const store = () => {
    if (closing) fail('platform_commerce_closed', 503);
    storePromise ??= openCommerceStore(dataDir);
    return storePromise;
  };
  const context = async (identity, expectedAccount) => {
    if (closing) fail('platform_commerce_closed', 503);
    const session = accountRuntime.captureCommerceSession(identity);
    if (!session.billingAccountId || (expectedAccount && expectedAccount !== session.billingAccountId)) fail('platform_account_changed', 409);
    const [rawAccounts, rawCapabilities] = await Promise.all([session.request('/v1/accounts'), session.request('/v1/capabilities', session.productWalletSupported === false ? undefined : productWalletHeaders())]);
    const account = parse(accountsSchema, rawAccounts).find((item) => item.id === session.billingAccountId);
    if (!account) fail('platform_account_forbidden', 403);
    const capabilities = parse(capabilitySchema, rawCapabilities);
    if (session.productWalletSupported === false) capabilities.product_credit_wallet = false;
    return { session, account, capabilities };
  };
  const requireFinance = (ctx, scopes) => {
    if (!financialRole(ctx.account.role)) fail('platform_billing_forbidden', 403);
    if (!hasScopes(ctx.capabilities, scopes)) fail('platform_scope_required', 403);
  };
  const catalog = async (ctx) => parse(z.array(offerSchema), await versionRequest(ctx, '/v1/catalog'))
    .filter((offer) => supportedOffer(offer, versioned(ctx)) && !offer.sandbox && offer.status === 'published' && (offer.account_kind === 'both' || offer.account_kind === ctx.account.kind));
  const wallet = async (ctx, init, suffix = 'product-wallet') => {
    const value = parse(productWalletSchema, await versionRequest(ctx, pathFor(ctx.account.id, suffix), init));
    if (value.account_id !== ctx.account.id) fail('platform_response_invalid', 502);
    return value;
  };
  const readOrders = async (ctx, useProductWallet = versioned(ctx)) => {
    const orders = parse(z.array(orderSchema), await versionRequest(ctx, pathFor(ctx.account.id, 'orders'), undefined, useProductWallet));
    if (orders.some((order) => order.account_id !== ctx.account.id || order.product_id !== order.offer.product_id)) fail('platform_response_invalid', 502);
    return orders.filter((order) => supportedOffer(order.offer, useProductWallet));
  };
  const checkedCashCheckout = (raw) => {
    const cash = parse(cashCheckoutSchema, raw);
    if (cash.wallet_target !== 'unified') fail('platform_response_invalid', 502);
    return parse(checkoutSchema, cashToCheckout(cash));
  };
  const readCheckout = async (ctx, checkoutId, action = 'read', init, useProductWallet) => {
    const cash = checkoutId.startsWith('ct_');
    const resource = cash ? 'cash-checkouts' : 'checkouts';
    const response = await requestCheckout(ctx, `${resource}/${segment(checkoutId)}${action === 'read' ? '' : `/${action}`}`, init, cash || useProductWallet);
    const checkout = cash ? checkedCashCheckout(response) : parse(checkoutSchema, response);
    if (checkout.account_id !== ctx.account.id || checkout.id !== checkoutId) fail('platform_response_invalid', 502);
    return checkout;
  };
  const resetUpgradeMatches = (intent, result) => Boolean(result.subscription_id && result.subscription_id !== intent.subscriptionId &&
    result.product_credit_upgrade?.previous_subscription_id === intent.subscriptionId &&
    result.product_credit_upgrade.previous_order_id === intent.previousOrderId);
  const checkoutValues = (intent, checkout) => {
    if (checkout.account_id !== intent.accountId || checkout.product_id !== intent.productId || checkout.provider !== intent.provider || checkout.amount !== intent.amount || Boolean(checkout.walletTopUp) !== Boolean(intent.walletTopUp)) fail('platform_response_invalid', 502);
    if (intent.previousOrderId && !resetUpgradeMatches(intent, checkout)) fail('platform_response_invalid', 502);
    return { resourceId: checkout.id, status: checkout.refund_status === 'SUCCEEDED' || checkout.payment_status === 'CLOSED' ? 'FAILED' : checkout.payment_status === 'PAID' && checkout.fulfillment_status === 'FULFILLED' && ['', 'REJECTED'].includes(checkout.refund_status) ? 'APPLIED' : 'PENDING', errorCode: checkout.error_code };
  };
  const mutateIntent = async (journal, storageId, values) => journal.mutate((intents) => {
    const intent = intents[storageId];
    if (!intent) fail('platform_intent_not_found', 404);
    Object.assign(intent, values, { updatedAt: new Date(now()).toISOString() });
    return structuredClone(intent);
  });
  const orderValues = (intent, order) => {
    if (order.account_id !== intent.accountId || order.actor_id !== intent.actorId || order.product_id !== intent.productId || order.offer.id !== intent.offerId || order.amount !== intent.amount) fail('platform_response_invalid', 502);
    if (intent.kind === 'upgrade' && (order.kind !== 'upgrade' || (intent.previousOrderId ? !resetUpgradeMatches(intent, order) : order.subscription_id !== intent.subscriptionId))) fail('platform_response_invalid', 502);
    return { resourceId: order.id, status: order.payment_status === 'PAID' && order.fulfillment_status === 'FULFILLED' ? 'APPLIED' : 'PENDING', errorCode: undefined };
  };
  const reconcileRead = async (ctx, journal, storageId, intent) => {
    if (!intent.resourceId) return intent;
    let values;
    if (intent.kind === 'checkout') values = checkoutValues(intent, await readCheckout(ctx, intent.resourceId, 'reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, Boolean(intent.walletVersion)));
    else {
      const order = (await readOrders(ctx, Boolean(intent.walletVersion))).find((item) => item.id === intent.resourceId);
      if (!order) fail('platform_order_unavailable', 503);
      values = orderValues(intent, order);
    }
    return mutateIntent(journal, storageId, values);
  };
  const dispatch = async (ctx, journal, storageId, intent) => {
    await mutateIntent(journal, storageId, { status: 'UNKNOWN', errorCode: undefined });
    try {
      const isProductWalletUpgrade = intent.walletVersion === PRODUCT_WALLET_VERSION && Boolean(intent.quoteId);
      const init = { method: 'POST', headers: { ...upgradeHeaders(isProductWalletUpgrade), 'Idempotency-Key': intent.idempotencyKey } };
      let values;
      let checkout;
      if (intent.kind === 'checkout') {
        const request = intent.walletTopUp ? { product_id: intent.productId, amount: intent.amount }
          : intent.quoteId ? { quote_id: intent.quoteId } : { offer_id: intent.offerId };
        request.provider = intent.provider;
        if (!intent.walletTopUp && intent.provider === 'alipay' && ctx.capabilities.alipay_checkout_qr === true) request.require_qr = true;
        init.body = JSON.stringify(request);
        const response = await requestCheckout(ctx, intent.walletTopUp ? 'cash-checkouts' : 'checkouts', init, Boolean(intent.walletVersion));
        checkout = intent.walletTopUp ? checkedCashCheckout(response) : parse(checkoutSchema, response);
        values = checkoutValues(intent, checkout);
      } else if (intent.kind === 'upgrade') {
        init.body = JSON.stringify({});
        const order = parse(orderSchema, await versionRequest(ctx, pathFor(intent.accountId, `quotes/${segment(intent.quoteId)}/accept`), init, Boolean(intent.walletVersion)));
        values = orderValues(intent, order);
      } else {
        init.body = JSON.stringify({ offer_id: intent.offerId });
        const order = parse(orderSchema, await versionRequest(ctx, pathFor(intent.accountId, 'orders'), init, Boolean(intent.walletVersion)));
        values = orderValues(intent, order);
      }
      const saved = await mutateIntent(journal, storageId, values);
      if (checkout) saved.checkout = checkout;
      return saved;
    } catch (error) {
      const sourceCode = safeError(error);
      const errorCode = sourceCode === 'insufficient_funds' && !intent.walletVersion ? 'payment_not_configured' : sourceCode;
      const rejectedQuote = (intent.kind === 'upgrade' || intent.kind === 'checkout' && Boolean(intent.quoteId)) && errorCode === 'quote_invalidated' && error.status === 409;
      return mutateIntent(journal, storageId, { status: rejectedCodes.has(errorCode) || rejectedQuote || errorCode === 'credit_rates_unavailable' && error.status === 409 ? 'FAILED' : 'UNKNOWN', errorCode });
    }
  };
  const exclusive = (storageId, action, signature) => {
    const existing = active.get(storageId);
    if (existing) {
      if (signature && existing.signature && signature !== existing.signature) fail('platform_idempotency_conflict', 409);
      return existing.promise;
    }
    const promise = action().finally(() => active.delete(storageId));
    active.set(storageId, { promise, signature });
    return promise;
  };
  const createIntent = async (ctx, body, kind, offer, quote) => {
    const journal = await store();
    const storageId = intentId(ctx.session, body.accountId, body.idempotencyKey);
    return exclusive(storageId, async () => {
        const heal = async () => journal.mutate((intents) => {
          let changed = false;
          for (const [storedId, saved] of Object.entries(intents)) {
            if (saved.serviceId !== ctx.session.serviceId || saved.actorId !== ctx.session.actingUserId || saved.accountId !== body.accountId || !releasablePreAdmissionIntent(saved, now())) continue;
            intents[storedId] = { ...saved, status: 'FAILED', errorCode: 'operation_pending', updatedAt: new Date(now()).toISOString() };
            changed = true;
          }
          return changed;
        });
        await heal();
      if (!journal.read()[storageId] && quote && Date.parse(quote.expiresAt) <= now()) fail('platform_quote_expired', 409);
      if (!journal.read()[storageId] && kind === 'purchase' && offer?.kind === 'membership') {
        requireFinance(ctx, ['subscriptions:read']);
        const subscriptions = parse(subscriptionsSchema, await versionRequest(ctx, pathFor(body.accountId, 'subscriptions')));
        if (subscriptions.some((subscription) => subscription.product_id === 'superwagie' && subscription.status === 'active' && Date.parse(subscription.paid_through) > now())) fail('platform_membership_active', 409);
      }
      const intent = {
        serviceId: ctx.session.serviceId, actorId: ctx.session.actingUserId, accountId: body.accountId,
        idempotencyKey: body.idempotencyKey, kind, productId: quote || body.amount ? 'superwagie' : offer.product_id,
        amount: quote?.amount ?? offer?.price ?? body.amount,
        walletTopUp: body.amount ? true : undefined,
        walletVersion: quote ? quote.walletVersion : versioned(ctx) ? PRODUCT_WALLET_VERSION : undefined,
        status: 'PREPARED', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
      };
      if (kind === 'checkout') {
        intent.provider = body.provider;
        intent.paymentSource = 'external';
      }
      if (offer) intent.offerId = offer.id;
      if (quote) { intent.offerId = quote.offerId; intent.quoteId = quote.id; intent.subscriptionId = quote.subscriptionId; intent.previousOrderId = quote.previousOrderId; }
      const { value, created } = await journal.mutate((intents) => {
        const existing = intents[storageId];
        if (existing) {
          if (existing.kind !== intent.kind || existing.productId !== intent.productId || existing.amount !== intent.amount || existing.offerId !== intent.offerId || existing.quoteId !== intent.quoteId || existing.provider !== intent.provider || existing.walletVersion !== intent.walletVersion || existing.previousOrderId !== intent.previousOrderId || existing.walletTopUp !== intent.walletTopUp) fail('platform_idempotency_conflict', 409);
          return { value: structuredClone(existing), created: false };
        }
        const unresolved = Object.values(intents).find((item) => item.kind !== 'recharge' && item.serviceId === intent.serviceId && item.actorId === intent.actorId && item.accountId === intent.accountId && (['PREPARED', 'UNKNOWN'].includes(item.status) || item.kind === 'checkout' && item.status === 'PENDING') && !releasablePreAdmissionIntent(item, now()));
        if (unresolved) {
          if (!hasScopes(ctx.capabilities, ['orders:read'])) fail('platform_scope_required', 403);
          fail('platform_operation_pending', 409);
        }
        intents[storageId] = intent;
        return { value: structuredClone(intent), created: true };
      });
      return publicIntent(created ? await dispatch(ctx, journal, storageId, value) : value);
    }, JSON.stringify([kind, offer?.product_id ?? 'superwagie', quote?.amount ?? offer?.price ?? body.amount, offer?.id, quote?.id, body.provider]));
  };
  const findIntent = async (ctx, idempotencyKey) => {
    parse(key, idempotencyKey, 'platform_request_invalid');
    const journal = await store();
    const storageId = intentId(ctx.session, ctx.account.id, idempotencyKey);
    const intent = journal.read()[storageId];
    if (!intent) fail('platform_intent_not_found', 404);
    return { journal, storageId };
  };
  return {
    orders: async (identity, accountId) => {
      const body = parse(accountInput, { accountId }, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, ['orders:read']);
      return (await readOrders(ctx)).map(publicOrder);
    },
    updateRenewal: async (identity, rawProduct, rawBody) => {
      const product = parse(walletProductId, rawProduct, 'platform_request_invalid');
      const body = parse(productRenewalInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, ['wallets:read', 'settings:write']);
      if (!versioned(ctx)) fail('platform_product_wallet_unavailable', 409);
      return wallet(ctx, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        kind: body.kind, enabled: body.enabled, expected_version: body.expectedVersion,
        offer_id: body.offerId, trigger: body.trigger, threshold: body.threshold,
      }) }, `product-wallet/${segment(product)}/renewal`);
    },
    overview: async (identity, { includeOrders = true } = {}) => {
      const ctx = await context(identity);
      const finance = financialRole(ctx.account.role);
      const canReadOrders = finance && hasScopes(ctx.capabilities, ['orders:read']);
      const canReadWallets = finance && hasScopes(ctx.capabilities, ['wallets:read', 'subscriptions:read']);
      const journal = finance ? await store() : null;
      const beforeCheckoutRead = journal?.read() ?? {};
      const canTopUp = versioned(ctx) && finance && hasScopes(ctx.capabilities, ['recharges:read', 'recharges:write']);
      const recoverCash = finance && hasScopes(ctx.capabilities, ['recharges:read']) && (versioned(ctx) || Object.values(beforeCheckoutRead).some((item) => item.walletTopUp && item.accountId === ctx.account.id && item.serviceId === ctx.session.serviceId && item.actorId === ctx.session.actingUserId));
      const [offers, resources, orders, commerceCheckouts, productWallet, cashRecords] = await Promise.all([
        hasScopes(ctx.capabilities, ['catalog:read']) ? catalog(ctx) : null,
        canReadWallets && !versioned(ctx) ? ctx.session.request(pathFor(ctx.account.id, 'resources')).then((value) => parse(resourcesSchema, value)) : null,
        includeOrders && canReadOrders ? readOrders(ctx) : null,
        canReadOrders && ctx.capabilities.payment_providers !== undefined
          ? requestCheckout(ctx, 'checkouts', undefined, false).then((value) => parseListedCheckouts(value, checkoutSchema, ctx.account.id)) : [],
        canReadWallets && versioned(ctx) ? wallet(ctx) : null,
        recoverCash ? requestCheckout(ctx, 'cash-checkouts', undefined, true).then((value) => parseListedCheckouts(value, cashCheckoutSchema, ctx.account.id)) : [],
      ]);
      const cashCheckouts = cashRecords.filter((item) => item.wallet_target === 'unified').map((item) => parse(checkoutSchema, cashToCheckout(item)));
      const pendingCash = cashCheckouts.findIndex((item) => ['CREATED', 'PENDING', 'UNKNOWN'].includes(item.payment_status) && Date.parse(item.expires_at) > now());
      if (pendingCash >= 0) cashCheckouts[pendingCash] = await readCheckout(ctx, cashCheckouts[pendingCash].id);
      const checkouts = [...commerceCheckouts, ...cashCheckouts];
      if (resources && (resources.account_id !== ctx.account.id || !resources.wallets)) fail('platform_response_invalid', 502);
      if (journal && canReadOrders && Object.values(journal.read()).some((intent) => intent.serviceId === ctx.session.serviceId && intent.actorId === ctx.session.actingUserId && intent.accountId === ctx.account.id && releasablePreAdmissionIntent(intent, now()))) {
        await journal.mutate((intents) => {
          for (const [storageId, intent] of Object.entries(intents)) {
            if (active.has(storageId) || intent.serviceId !== ctx.session.serviceId || intent.actorId !== ctx.session.actingUserId || intent.accountId !== ctx.account.id || !releasablePreAdmissionIntent(intent, now())) continue;
            intents[storageId] = { ...intent, status: 'FAILED', errorCode: 'operation_pending', updatedAt: new Date(now()).toISOString() };
          }
        });
      }
      const updates = Object.entries(beforeCheckoutRead).flatMap(([storageId, intent]) => {
        if (intent.kind !== 'checkout' || !intent.resourceId || intent.serviceId !== ctx.session.serviceId || intent.actorId !== ctx.session.actingUserId || intent.accountId !== ctx.account.id) return [];
        const checkout = checkouts.find((item) => item.id === intent.resourceId);
        if (!checkout) return [];
        const values = checkoutValues(intent, checkout);
        return intent.status === values.status && intent.errorCode === values.errorCode ? [] : [{ storageId, intent, values }];
      });
      if (journal && updates.length) await journal.mutate((intents) => {
        for (const { storageId, intent, values } of updates) {
          // A read started before a refund or reconciliation cannot overwrite it.
          if (active.has(storageId) || !isDeepStrictEqual(intents[storageId], intent)) continue;
          Object.assign(intents[storageId], values, { updatedAt: new Date(now()).toISOString() });
        }
      });
      const intents = journal ? Object.values(journal.read()).filter((intent) => intent.kind !== 'recharge' && intent.serviceId === ctx.session.serviceId && intent.actorId === ctx.session.actingUserId && intent.accountId === ctx.account.id && hasScopes(ctx.capabilities, ['orders:read'])).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicIntent) : [];
      const providers = checkoutProviders(ctx.capabilities);
      return {
        accountId: ctx.account.id, role: ctx.account.role, financialAccess: finance,
        missingScopes: requiredScopes.filter((scope) => !ctx.capabilities.scopes.includes(scope)),
        payments: { mode: ctx.capabilities.real_payments_configured && providers.length ? 'external' : 'unconfigured', providers, canPurchase: finance && hasScopes(ctx.capabilities, ['orders:read', 'orders:write', 'catalog:read']), ...(versioned(ctx) && { canTopUp }) },
        wallets: productWallet ? [{ productId: '', asset: productWallet.cash.asset, amount: productWallet.cash.available }] : resources ? resources.wallets.map((wallet) => ({ productId: wallet.product_id, asset: wallet.asset, amount: wallet.amount })) : null,
        offers: offers?.map((offer) => publicOffer(offer, ctx.capabilities)) ?? null, orders: orders?.map(publicOrder) ?? null, intents,
        checkouts, ...(versioned(ctx) && { productCreditWallet: true, productWallet }),
      };
    },
    createCheckout: async (identity, rawBody) => {
      const body = parse(checkoutInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, body.amount ? ['recharges:read', 'recharges:write'] : ['catalog:read', 'orders:read', 'orders:write']);
      const previous = (await store()).read()[intentId(ctx.session, body.accountId, body.idempotencyKey)];
      if (previous) {
        if (previous.kind !== 'checkout' || previous.provider !== body.provider || previous.quoteId !== body.quoteId || Boolean(previous.walletTopUp) !== Boolean(body.amount) || (body.amount && previous.amount !== body.amount) || (!body.quoteId && previous.offerId !== body.offerId)) fail('platform_idempotency_conflict', 409);
        return publicIntent(previous);
      }
      if (!ctx.capabilities.real_payments_configured || !checkoutProviders(ctx.capabilities).includes(body.provider)) fail('payment_not_configured', 503);
      if (body.amount) {
        if (!versioned(ctx)) fail('platform_product_wallet_unavailable', 409);
        return createIntent(ctx, body, 'checkout');
      }
      let quote; let offer;
      if (body.quoteId) {
        quote = (await store()).readQuotes()[intentId(ctx.session, body.accountId, body.quoteId)];
        if (!quote || quote.paymentSource !== 'external') fail('platform_quote_unavailable', 409);
        if (pointsRuntimeUnavailable(quote.pricingProgram, ctx.capabilities)) fail('points_runtime_unavailable', 409);
      } else {
        offer = (await catalog(ctx)).find((item) => item.id === body.offerId);
        if (!offer) fail('platform_offer_unavailable', 404);
        if (pointsRuntimeUnavailable(offer.entitlements?.pricing_program, ctx.capabilities)) fail('points_runtime_unavailable', 409);
      }
      return createIntent(ctx, body, 'checkout', offer, quote);
    },
    checkoutAction: async (identity, checkoutId, action, rawBody) => {
      parse(id, checkoutId, 'platform_request_invalid');
      const body = parse(accountInput.extend({ reason: refundReasonSchema.optional() }), rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      const cash = checkoutId.startsWith('ct_');
      const scopes = cash ? ['recharges:read', 'recharges:write'] : ['orders:read', 'orders:write'];
      requireFinance(ctx, action === 'read' ? scopes.slice(0, 1) : scopes);
      if (!['read', 'reconcile', 'close', 'refund'].includes(action) || cash && action === 'refund') fail('platform_request_invalid');
      const journal = await store();
      let storageId = Object.keys(journal.read()).find((entry) => {
        const intent = journal.read()[entry];
        return intent.kind === 'checkout' && intent.resourceId === checkoutId && intent.serviceId === ctx.session.serviceId && intent.actorId === ctx.session.actingUserId && intent.accountId === ctx.account.id;
      });
      // Refund keys are durable before dispatch, including response-loss recovery.
      const run = async () => {
        let intent = storageId ? journal.read()[storageId] : null;
        if (action === 'refund') {
          // A legacy invalid reason may already have been dispatched. No local
          // evidence proves whether upstream admitted it, so preserve its key.
          if (intent?.refundKey && !refundReasonSchema.safeParse(intent.refundReason).success) fail('platform_refund_repair_required', 409);
          const original = !intent?.refundKey || intent.walletVersion ? await readCheckout(ctx, checkoutId, 'read', undefined, false) : undefined;
          if (original?.upgrade_return_status) fail('platform_upgrade_return_managed', 409);
          if (!intent?.refundKey) {
            // A refund rejected on another instance has no local replay key.
            // Return its authoritative receipt instead of inventing a new request.
            if (original.refund_status === 'REJECTED') {
              if (intent) await mutateIntent(journal, storageId, checkoutValues(intent, original));
              return original;
            }
            if (!intent) {
              const recoveryKey = crypto.randomUUID();
              storageId = intentId(ctx.session, ctx.account.id, recoveryKey);
              intent = { serviceId: ctx.session.serviceId, actorId: ctx.session.actingUserId, accountId: ctx.account.id, idempotencyKey: recoveryKey, kind: 'checkout', provider: original.provider, productId: original.product_id, amount: original.amount, paymentSource: 'external', resourceId: original.id, status: 'PENDING', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
              await journal.mutate((intents) => { intents[storageId] = intent; });
            }
            intent = await mutateIntent(journal, storageId, { refundKey: crypto.randomUUID(), refundReason: body.reason ?? 'Customer requested refund' });
          }
        }
        const headers = { 'Content-Type': 'application/json' };
        if (intent?.refundKey && action === 'refund') headers['Idempotency-Key'] = intent.refundKey;
        const checkout = await readCheckout(ctx, checkoutId, action, action === 'read' ? undefined : { method: 'POST', headers, body: JSON.stringify(action === 'refund' ? { reason: intent.refundReason } : {}) }, false);
        if (intent) await mutateIntent(journal, storageId, checkoutValues(intent, checkout));
        return checkout;
      };
      const key = storageId ?? `checkout:${ctx.session.serviceId}:${ctx.account.id}:${checkoutId}`;
      const signature = `checkout:${action}`;
      // Reconciliation and cancellation have distinct effects. A background
      // status request must not absorb a close command for the same order.
      for (;;) {
        const existing = active.get(key);
        if (!existing || existing.signature === signature) return exclusive(key, run, signature);
        await existing.promise.catch(() => {});
      }
    },
    purchase: async (identity, rawBody) => {
      const body = parse(purchaseInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, ['catalog:read', 'orders:read', 'orders:write']);
      const previous = (await store()).read()[intentId(ctx.session, body.accountId, body.idempotencyKey)];
      if (previous) {
        if (previous.kind !== 'purchase' || previous.offerId !== body.offerId) fail('platform_idempotency_conflict', 409);
        return publicIntent(previous);
      }
      const offer = (await catalog(ctx)).find((item) => item.id === body.offerId);
      if (!offer) fail('platform_offer_unavailable', 404);
      if (pointsRuntimeUnavailable(offer.entitlements?.pricing_program, ctx.capabilities)) fail('points_runtime_unavailable', 409);
      return createIntent(ctx, body, 'purchase', offer);
    },
    quoteUpgrade: async (identity, rawBody) => {
      const body = parse(quoteInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, ['catalog:read', 'subscriptions:read', 'orders:read', 'orders:write']);
      const offer = (await catalog(ctx)).find((item) => item.id === body.offerId && item.product_id === 'superwagie' && item.kind === 'membership');
      if (!offer) fail('platform_offer_unavailable', 404);
      if (pointsRuntimeUnavailable(offer.entitlements?.pricing_program, ctx.capabilities)) fail('points_runtime_unavailable', 409);
      const input = { subscription_id: body.subscriptionId, offer_id: body.offerId };
      if (body.paymentSource === 'external') input.payment_source = 'external';
      const useProductWallet = versioned(ctx);
      const quote = parse(quoteSchema, await versionRequest(ctx, pathFor(body.accountId, 'quotes'), { method: 'POST', headers: upgradeHeaders(useProductWallet), body: JSON.stringify(input) }));
      if (quote.account_id !== body.accountId || quote.subscription_id !== body.subscriptionId || quote.offer.id !== body.offerId || quote.offer.product_id !== 'superwagie' || quote.offer.kind !== 'membership' || quote.offer.sandbox !== offer.sandbox || quote.offer.credit_scope !== offer.credit_scope || quote.offer.entitlements?.pricing_program !== offer.entitlements?.pricing_program || Date.parse(quote.expires_at) <= now()) fail('platform_response_invalid', 502);
      if (pointsRuntimeUnavailable(quote.offer.entitlements?.pricing_program, ctx.capabilities)) fail('points_runtime_unavailable', 409);
      if (body.paymentSource === 'external' && (quote.payment_source !== 'external' || quote.rounding_rule !== 'cny_cent_ceil_v1' || !quote.original_amount || BigInt(quote.amount) !== ((BigInt(quote.original_amount) + 9999n) / 10000n) * 10000n)) fail('platform_response_invalid', 502);
      const reset = quote.product_credit_upgrade;
      if (Boolean(reset) !== useProductWallet || (reset && (reset.previous_subscription_id !== quote.subscription_id || quote.grant_amount !== offer.monthly_credit))) fail('platform_response_invalid', 502);
      const appliedCreditAmount = reset?.applied_credit_amount;
      if (appliedCreditAmount !== undefined) {
        const amountDue = BigInt(quote.amount);
        if (reset.estimated_refund_amount !== '0' || quote.offer.price !== offer.price || amountDue <= 0n || amountDue + BigInt(appliedCreditAmount) !== BigInt(offer.price)) fail('platform_response_invalid', 502);
      } else if (reset && (quote.amount !== offer.price || (body.paymentSource === 'external' && quote.original_amount !== offer.price))) {
        fail('platform_response_invalid', 502);
      }
      const journal = await store();
      const quoteStorageId = intentId(ctx.session, body.accountId, quote.id);
      const binding = { paymentSource: body.paymentSource, walletVersion: useProductWallet ? PRODUCT_WALLET_VERSION : undefined, previousOrderId: reset?.previous_order_id, id: quote.id, serviceId: ctx.session.serviceId, actorId: ctx.session.actingUserId, accountId: body.accountId, subscriptionId: body.subscriptionId, offerId: quote.offer.id, amount: quote.amount, expiresAt: quote.expires_at, sandbox: quote.offer.sandbox, pricingProgram: quote.offer.entitlements?.pricing_program };
      await journal.mutate((_intents, quotes) => {
        const previous = quotes[quoteStorageId];
        if (previous && (previous.subscriptionId !== binding.subscriptionId || previous.offerId !== binding.offerId || previous.amount !== binding.amount || previous.expiresAt !== binding.expiresAt || previous.sandbox !== binding.sandbox || previous.pricingProgram !== binding.pricingProgram || previous.paymentSource !== binding.paymentSource || previous.walletVersion !== binding.walletVersion || previous.previousOrderId !== binding.previousOrderId)) fail('platform_response_invalid', 502);
        for (const [storedId, saved] of Object.entries(quotes)) if (Date.parse(saved.expiresAt) <= now()) delete quotes[storedId];
        quotes[quoteStorageId] = binding;
      });
      return { paymentSource: body.paymentSource, roundingRule: quote.rounding_rule, originalAmount: quote.original_amount, id: quote.id, accountId: quote.account_id, subscriptionId: quote.subscription_id, subscriptionVersion: quote.subscription_version, offer: publicOffer(quote.offer, ctx.capabilities), amount: quote.amount, additionalCredits: quote.grant_amount, periodStart: quote.period_start, expiresAt: quote.expires_at, createdAt: quote.created_at, ...(reset && { productCreditUpgrade: { previousOrderId: reset.previous_order_id, estimatedRefundAmount: reset.estimated_refund_amount, refundPaymentSource: reset.refund_payment_source, ...(appliedCreditAmount !== undefined && { appliedCreditAmount }) } }) };
    },
    acceptUpgrade: async (identity, rawBody) => {
      const body = parse(upgradeInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, ['orders:read', 'orders:write', 'subscriptions:read']);
      const journal = await store();
      const previous = journal.read()[intentId(ctx.session, body.accountId, body.idempotencyKey)];
      if (previous) {
        if (previous.kind !== 'upgrade' || previous.quoteId !== body.quoteId) fail('platform_idempotency_conflict', 409);
        return publicIntent(previous);
      }
      const quote = journal.readQuotes()[intentId(ctx.session, body.accountId, body.quoteId)];
      if (!quote || quote.accountId !== body.accountId || quote.actorId !== ctx.session.actingUserId || quote.serviceId !== ctx.session.serviceId) fail('platform_quote_unavailable', 404);
      if (quote.paymentSource === 'external') fail('platform_quote_unavailable', 409);
      if (Date.parse(quote.expiresAt) <= now()) fail('platform_quote_expired', 409);
      if (quote.sandbox) fail('payment_not_configured', 503);
      if (pointsRuntimeUnavailable(quote.pricingProgram, ctx.capabilities)) fail('points_runtime_unavailable', 409);
      return createIntent(ctx, body, 'upgrade', undefined, quote);
    },
    reconcile: async (identity, idempotencyKey, rawBody) => {
      const body = parse(accountInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      const { journal, storageId } = await findIntent(ctx, idempotencyKey);
      if (journal.read()[storageId]?.kind === 'recharge') fail('platform_request_invalid', 409);
      const cash = journal.read()[storageId]?.walletTopUp;
      requireFinance(ctx, cash ? ['recharges:read'] : ['orders:read']);
      return exclusive(storageId, async () => {
        const intent = journal.read()[storageId];
        if (intent.resourceId) return publicIntent(await reconcileRead(ctx, journal, storageId, intent));
        if (!['PREPARED', 'UNKNOWN'].includes(intent.status)) return publicIntent(intent);
        requireFinance(ctx, cash ? ['recharges:write'] : ['orders:write']);
        return publicIntent(await dispatch(ctx, journal, storageId, intent));
      });
    },
    close: async () => {
      closing = true;
      await Promise.allSettled([...active.values()].map((entry) => entry.promise));
      if (storePromise) await (await storePromise).close();
    },
  };
};
