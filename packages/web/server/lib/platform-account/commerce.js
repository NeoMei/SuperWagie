import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PlatformAccountError } from './runtime.js';
import { openCommerceStore, refundReasonSchema } from './commerce-store.js';

const id = z.string().min(1).max(200);
const units = z.string().regex(/^(0|[1-9]\d*)$/);
const product = z.enum(['superwagie', 'llmrouter']);
const key = z.string().uuid();
const accountInput = z.object({ accountId: id }).strict();
const purchaseInput = accountInput.extend({ offerId: id, idempotencyKey: key });
const quoteInput = accountInput.extend({ subscriptionId: id, offerId: id, paymentSource: z.enum(['wallet', 'external']).default('wallet') });
const checkoutInput = accountInput.extend({ offerId: id.optional(), quoteId: id.optional(), provider: z.enum(['wechat', 'alipay']), idempotencyKey: key }).refine((value) => Boolean(value.offerId) !== Boolean(value.quoteId));
const upgradeInput = accountInput.extend({ quoteId: id, idempotencyKey: key });
const accountsSchema = z.array(z.object({ id, kind: z.enum(['personal', 'team']), role: z.string() }));
const capabilitySchema = z.object({ product_id: z.literal('superwagie'), scopes: z.array(z.string()), sandbox: z.boolean(), product_wallet_recharge: z.boolean(), real_payments_configured: z.boolean(), payment_providers: z.array(z.enum(['wechat', 'alipay'])).optional(), native_credits: z.object({ ready: z.boolean() }).optional() });
const walletSchema = z.object({ product_id: z.string(), asset: z.literal('CNY/6'), amount: units });
const subscriptionsSchema = z.array(z.object({ product_id: z.string(), status: z.string(), paid_through: z.string().datetime() }));
const resourcesSchema = z.object({ account_id: id, wallets: z.array(walletSchema).optional(), as_of: z.string() });
const salesReadinessSchema = z.discriminatedUnion('ready', [
  z.object({ ready: z.literal(true) }),
  z.object({ ready: z.literal(false), reason: z.literal('credit_rates_unavailable') }),
]);
const offerSchema = z.object({
  sales_readiness: salesReadinessSchema.optional(),
  id, product_id: z.string(), name: z.string(), account_kind: z.enum(['personal', 'team', 'both']),
  kind: z.enum(['membership', 'addon']), period: z.string(), price: units, monthly_credit: units,
  validity_months: z.number().int().nonnegative(), rank: z.number().int().nonnegative(), sandbox: z.boolean(), status: z.string(),
  entitlements: z.object({ pricing_program: z.string().optional() }).nullish().transform((value) => value ?? undefined),
});
const orderSchema = z.object({
  id, account_id: id, actor_id: id, product_id: z.string(), offer: offerSchema, amount: units,
  payment_status: z.string(), fulfillment_status: z.string(), refund_status: z.string().optional(),
  kind: z.string().optional(), subscription_id: id.optional(),
});
const quoteSchema = z.object({
  payment_source: z.enum(['wallet', 'external']).optional(), rounding_rule: z.literal('cny_cent_ceil_v1').optional(), original_amount: units.optional(),
  id, account_id: id, subscription_id: id, subscription_version: z.number().int().nonnegative(),
  offer: offerSchema, amount: units, grant_amount: units,
  period_start: z.string().datetime(), expires_at: z.string().datetime(), created_at: z.string().datetime(),
});
const checkoutSchema = z.object({
  id, account_id: id, product_id: product, provider: z.enum(['wechat', 'alipay']), offer_name: z.string(), amount: units, currency: z.literal('CNY'),
  payment_status: z.enum(['CREATED', 'PENDING', 'UNKNOWN', 'PAID', 'CLOSED', 'REVIEW']), fulfillment_status: z.enum(['NOT_STARTED', 'PENDING', 'FULFILLED', 'REVIEW']), refund_status: z.enum(['', 'PENDING', 'SUCCEEDED', 'REVIEW', 'REJECTED']).default(''),
  expires_at: z.string().datetime(), created_at: z.string().datetime(), order_id: id.optional(), error_code: z.string().optional(),
  session: z.object({ kind: z.enum(['qr', 'redirect']), url: z.string().min(1).max(16000), expires_at: z.string().datetime() }).optional(),
}).superRefine((value, ctx) => {
  if (!value.session) return;
  try {
    const url = new URL(value.session.url);
    const valid = value.provider === 'wechat' ? value.session.kind === 'qr' && url.protocol === 'weixin:'
      : value.session.kind === 'redirect' && url.protocol === 'https:' && url.hostname === 'openapi.alipay.com' && url.pathname === '/gateway.do' && !url.port && !url.username && !url.password;
    if (!valid) ctx.addIssue({ code: 'custom', message: 'Invalid provider session' });
  } catch { ctx.addIssue({ code: 'custom', message: 'Invalid provider session' }); }
});
const requiredScopes = ['catalog:read', 'subscriptions:read', 'wallets:read', 'orders:read', 'orders:write'];
const fail = (code, status = 400) => { throw new PlatformAccountError(code, status); };
const parse = (schema, value, code = 'platform_response_invalid') => {
  const result = schema.safeParse(value);
  if (!result.success) fail(code, code === 'platform_request_invalid' ? 400 : 502);
  return result.data;
};
const segment = (value) => encodeURIComponent(value);
const pathFor = (accountId, suffix) => `/v1/accounts/${segment(accountId)}/${suffix}`;
const hasScopes = (caps, names) => names.every((scope) => caps.scopes.includes(scope));
const financialRole = (role) => role === 'owner' || role === 'billing_admin';
const supportedOffer = (offer) => offer.product_id === 'superwagie' || (offer.product_id === 'llmrouter' && offer.kind === 'addon');
const pointsRuntimeUnavailable = (pricingProgram, capabilities) => pricingProgram === 'superwagie-ai-points-v1' && capabilities?.native_credits?.ready !== true;
const publicOffer = (offer, capabilities) => ({ id: offer.id, productId: offer.product_id, name: offer.name, accountKind: offer.account_kind, kind: offer.kind, period: offer.period, price: offer.price, monthlyCredit: offer.monthly_credit, validityMonths: offer.validity_months, rank: offer.rank, sandbox: offer.sandbox, salesReadiness: offer.sales_readiness, pricingProgram: offer.entitlements?.pricing_program, purchaseReadiness: pointsRuntimeUnavailable(offer.entitlements?.pricing_program, capabilities) ? { ready: false, reason: 'points_runtime_unavailable' } : { ready: true } });
const publicOrder = (order) => ({ id: order.id, productId: order.product_id, offerName: order.offer.name, amount: order.amount, paymentStatus: order.payment_status, fulfillmentStatus: order.fulfillment_status, refundStatus: order.refund_status ?? '' });
const publicIntent = (intent) => ({ idempotencyKey: intent.idempotencyKey, kind: intent.kind, accountId: intent.accountId, productId: intent.productId, amount: intent.amount, offerId: intent.offerId, resourceId: intent.resourceId, quoteId: intent.quoteId, provider: intent.provider, subscriptionId: intent.subscriptionId, status: intent.status, errorCode: intent.errorCode, createdAt: intent.createdAt });
const intentId = (session, accountId, idempotencyKey) => crypto.createHash('sha256').update(JSON.stringify([session.serviceId, session.actingUserId, accountId, idempotencyKey])).digest('hex');
const safeError = (error) => error instanceof PlatformAccountError && /^[a-z][a-z0-9_]{0,100}$/.test(error.code) ? error.code : 'platform_commerce_unavailable';
const rejectedCodes = new Set(['invalid_request', 'forbidden', 'insufficient_funds', 'insufficient_credits', 'not_found', 'unsupported_plan_change', 'subscription_required', 'payment_not_configured']);

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
    const [rawAccounts, rawCapabilities] = await Promise.all([session.request('/v1/accounts'), session.request('/v1/capabilities')]);
    const account = parse(accountsSchema, rawAccounts).find((item) => item.id === session.billingAccountId);
    if (!account) fail('platform_account_forbidden', 403);
    const capabilities = parse(capabilitySchema, rawCapabilities);
    return { session, account, capabilities };
  };
  const requireFinance = (ctx, scopes) => {
    if (!financialRole(ctx.account.role)) fail('platform_billing_forbidden', 403);
    if (!hasScopes(ctx.capabilities, scopes)) fail('platform_scope_required', 403);
  };
  const catalog = async (ctx) => parse(z.array(offerSchema), await ctx.session.request('/v1/catalog'))
    .filter((offer) => supportedOffer(offer) && !offer.sandbox && offer.status === 'published' && (offer.account_kind === 'both' || offer.account_kind === ctx.account.kind));
  const readOrders = async (ctx) => {
    const orders = parse(z.array(orderSchema), await ctx.session.request(pathFor(ctx.account.id, 'orders')));
    if (orders.some((order) => order.account_id !== ctx.account.id || order.product_id !== order.offer.product_id)) fail('platform_response_invalid', 502);
    return orders.filter((order) => supportedOffer(order.offer));
  };
  const readCheckout = async (ctx, checkoutId, action = 'read', init) => {
    const checkout = parse(checkoutSchema, await ctx.session.request(pathFor(ctx.account.id, `checkouts/${segment(checkoutId)}${action === 'read' ? '' : `/${action}`}`), init));
    if (checkout.account_id !== ctx.account.id || checkout.id !== checkoutId) fail('platform_response_invalid', 502);
    return checkout;
  };
  const checkoutValues = (intent, checkout) => {
    if (checkout.account_id !== intent.accountId || checkout.product_id !== intent.productId || checkout.provider !== intent.provider || checkout.amount !== intent.amount) fail('platform_response_invalid', 502);
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
    if (intent.kind === 'upgrade' && (order.kind !== 'upgrade' || order.subscription_id !== intent.subscriptionId)) fail('platform_response_invalid', 502);
    return { resourceId: order.id, status: order.payment_status === 'PAID' && order.fulfillment_status === 'FULFILLED' ? 'APPLIED' : 'PENDING', errorCode: undefined };
  };
  const reconcileRead = async (ctx, journal, storageId, intent) => {
    if (!intent.resourceId) return intent;
    let values;
    if (intent.kind === 'checkout') values = checkoutValues(intent, await readCheckout(ctx, intent.resourceId, 'reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    else {
      const order = (await readOrders(ctx)).find((item) => item.id === intent.resourceId);
      if (!order) fail('platform_order_unavailable', 503);
      values = orderValues(intent, order);
    }
    return mutateIntent(journal, storageId, values);
  };
  const dispatch = async (ctx, journal, storageId, intent) => {
    await mutateIntent(journal, storageId, { status: 'UNKNOWN', errorCode: undefined });
    try {
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': intent.idempotencyKey } };
      let values;
      if (intent.kind === 'checkout') {
        init.body = JSON.stringify({ ...(intent.quoteId ? { quote_id: intent.quoteId } : { offer_id: intent.offerId }), provider: intent.provider });
        values = checkoutValues(intent, parse(checkoutSchema, await ctx.session.request(pathFor(intent.accountId, 'checkouts'), init)));
      } else if (intent.kind === 'upgrade') {
        init.body = JSON.stringify({});
        const order = parse(orderSchema, await ctx.session.request(pathFor(intent.accountId, `quotes/${segment(intent.quoteId)}/accept`), init));
        values = orderValues(intent, order);
      } else {
        init.body = JSON.stringify({ offer_id: intent.offerId });
        const order = parse(orderSchema, await ctx.session.request(pathFor(intent.accountId, 'orders'), init));
        values = orderValues(intent, order);
      }
      return mutateIntent(journal, storageId, values);
    } catch (error) {
      const sourceCode = safeError(error);
      const errorCode = sourceCode === 'insufficient_funds' ? 'payment_not_configured' : sourceCode;
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
      if (!journal.read()[storageId] && quote && Date.parse(quote.expiresAt) <= now()) fail('platform_quote_expired', 409);
      if (!journal.read()[storageId] && kind === 'purchase' && offer?.kind === 'membership') {
        requireFinance(ctx, ['subscriptions:read']);
        const subscriptions = parse(subscriptionsSchema, await ctx.session.request(pathFor(body.accountId, 'subscriptions')));
        if (subscriptions.some((subscription) => subscription.product_id === 'superwagie' && subscription.status === 'active' && Date.parse(subscription.paid_through) > now())) fail('platform_membership_active', 409);
      }
      const intent = {
        serviceId: ctx.session.serviceId, actorId: ctx.session.actingUserId, accountId: body.accountId,
        idempotencyKey: body.idempotencyKey, kind, productId: quote ? 'superwagie' : offer?.product_id ?? body.productId,
        amount: quote?.amount ?? offer?.price ?? body.amount,
        status: 'PREPARED', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
      };
      if (kind === 'checkout') { intent.provider = body.provider; intent.paymentSource = 'external'; }
      if (offer) intent.offerId = offer.id;
      if (quote) { intent.offerId = quote.offerId; intent.quoteId = quote.id; intent.subscriptionId = quote.subscriptionId; }
      const { value, created } = await journal.mutate((intents) => {
        const existing = intents[storageId];
        if (existing) {
          if (existing.kind !== intent.kind || existing.productId !== intent.productId || existing.amount !== intent.amount || existing.offerId !== intent.offerId || existing.quoteId !== intent.quoteId || existing.provider !== intent.provider) fail('platform_idempotency_conflict', 409);
          return { value: structuredClone(existing), created: false };
        }
        const unresolved = Object.values(intents).find((item) => item.kind !== 'recharge' && item.serviceId === intent.serviceId && item.actorId === intent.actorId && item.accountId === intent.accountId && (['PREPARED', 'UNKNOWN'].includes(item.status) || item.kind === 'checkout' && item.status === 'PENDING'));
        if (unresolved) {
          if (!hasScopes(ctx.capabilities, ['orders:read'])) fail('platform_scope_required', 403);
          fail('platform_operation_pending', 409);
        }
        intents[storageId] = intent;
        return { value: structuredClone(intent), created: true };
      });
      return publicIntent(created ? await dispatch(ctx, journal, storageId, value) : value);
    }, JSON.stringify([kind, offer?.product_id ?? body.productId, quote?.amount ?? offer?.price ?? body.amount, offer?.id, quote?.id, body.provider]));
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
    overview: async (identity) => {
      const ctx = await context(identity);
      const finance = financialRole(ctx.account.role);
      const canReadWallets = finance && hasScopes(ctx.capabilities, ['wallets:read', 'subscriptions:read']);
      const [offers, resources, orders] = await Promise.all([
        hasScopes(ctx.capabilities, ['catalog:read']) ? catalog(ctx) : null,
        canReadWallets ? ctx.session.request(pathFor(ctx.account.id, 'resources')).then((value) => parse(resourcesSchema, value)) : null,
        finance && hasScopes(ctx.capabilities, ['orders:read']) ? readOrders(ctx) : null,
      ]);
      if (resources && (resources.account_id !== ctx.account.id || !resources.wallets)) fail('platform_response_invalid', 502);
      const journal = finance ? await store() : null;
      const beforeCheckoutRead = journal?.read() ?? {};
      const checkouts = finance && hasScopes(ctx.capabilities, ['orders:read']) && ctx.capabilities.payment_providers !== undefined
        ? parse(z.array(checkoutSchema), await ctx.session.request(pathFor(ctx.account.id, 'checkouts'))) : [];
      if (checkouts.some((item) => item.account_id !== ctx.account.id)) fail('platform_response_invalid', 502);
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
      return {
        accountId: ctx.account.id, role: ctx.account.role, financialAccess: finance,
        missingScopes: requiredScopes.filter((scope) => !ctx.capabilities.scopes.includes(scope)),
        payments: { mode: ctx.capabilities.real_payments_configured && ctx.capabilities.payment_providers?.length ? 'external' : 'unconfigured', providers: ctx.capabilities.payment_providers ?? [], canPurchase: finance && hasScopes(ctx.capabilities, ['orders:read', 'orders:write', 'catalog:read']) },
        wallets: resources ? resources.wallets.map((wallet) => ({ productId: wallet.product_id, asset: wallet.asset, amount: wallet.amount })) : null,
        offers: offers?.map((offer) => publicOffer(offer, ctx.capabilities)) ?? null, orders: orders?.map(publicOrder) ?? null, intents,
        checkouts,
      };
    },
    createCheckout: async (identity, rawBody) => {
      const body = parse(checkoutInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, ['catalog:read', 'orders:read', 'orders:write']);
      const previous = (await store()).read()[intentId(ctx.session, body.accountId, body.idempotencyKey)];
      if (previous) {
        if (previous.kind !== 'checkout' || previous.provider !== body.provider || previous.quoteId !== body.quoteId || (!body.quoteId && previous.offerId !== body.offerId)) fail('platform_idempotency_conflict', 409);
        return publicIntent(previous);
      }
      if (!ctx.capabilities.real_payments_configured || !ctx.capabilities.payment_providers?.includes(body.provider)) fail('payment_not_configured', 503);
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
      requireFinance(ctx, action === 'read' ? ['orders:read'] : ['orders:read', 'orders:write']);
      if (!['read', 'reconcile', 'close', 'refund'].includes(action)) fail('platform_request_invalid');
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
          if (!intent?.refundKey) {
            const original = await readCheckout(ctx, checkoutId);
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
        const checkout = await readCheckout(ctx, checkoutId, action, action === 'read' ? undefined : { method: 'POST', headers, body: JSON.stringify(action === 'refund' ? { reason: intent.refundReason } : {}) });
        if (intent) await mutateIntent(journal, storageId, checkoutValues(intent, checkout));
        return checkout;
      };
      return exclusive(storageId ?? `checkout:${ctx.session.serviceId}:${ctx.account.id}:${checkoutId}`, run);
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
      const quote = parse(quoteSchema, await ctx.session.request(pathFor(body.accountId, 'quotes'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
      if (quote.account_id !== body.accountId || quote.subscription_id !== body.subscriptionId || quote.offer.id !== body.offerId || quote.offer.product_id !== 'superwagie' || quote.offer.kind !== 'membership' || quote.offer.sandbox !== offer.sandbox || quote.offer.entitlements?.pricing_program !== offer.entitlements?.pricing_program || Date.parse(quote.expires_at) <= now()) fail('platform_response_invalid', 502);
      if (pointsRuntimeUnavailable(quote.offer.entitlements?.pricing_program, ctx.capabilities)) fail('points_runtime_unavailable', 409);
      if (body.paymentSource === 'external' && (quote.payment_source !== 'external' || quote.rounding_rule !== 'cny_cent_ceil_v1' || !quote.original_amount || BigInt(quote.amount) !== ((BigInt(quote.original_amount) + 9999n) / 10000n) * 10000n)) fail('platform_response_invalid', 502);
      const journal = await store();
      const quoteStorageId = intentId(ctx.session, body.accountId, quote.id);
      const binding = { paymentSource: body.paymentSource, id: quote.id, serviceId: ctx.session.serviceId, actorId: ctx.session.actingUserId, accountId: body.accountId, subscriptionId: body.subscriptionId, offerId: quote.offer.id, amount: quote.amount, expiresAt: quote.expires_at, sandbox: quote.offer.sandbox, pricingProgram: quote.offer.entitlements?.pricing_program };
      await journal.mutate((_intents, quotes) => {
        const previous = quotes[quoteStorageId];
        if (previous && (previous.subscriptionId !== binding.subscriptionId || previous.offerId !== binding.offerId || previous.amount !== binding.amount || previous.expiresAt !== binding.expiresAt || previous.sandbox !== binding.sandbox || previous.pricingProgram !== binding.pricingProgram || previous.paymentSource !== binding.paymentSource)) fail('platform_response_invalid', 502);
        for (const [storedId, saved] of Object.entries(quotes)) if (Date.parse(saved.expiresAt) <= now()) delete quotes[storedId];
        quotes[quoteStorageId] = binding;
      });
      return { paymentSource: body.paymentSource, roundingRule: quote.rounding_rule, originalAmount: quote.original_amount, id: quote.id, accountId: quote.account_id, subscriptionId: quote.subscription_id, subscriptionVersion: quote.subscription_version, offer: publicOffer(quote.offer, ctx.capabilities), amount: quote.amount, additionalCredits: quote.grant_amount, periodStart: quote.period_start, expiresAt: quote.expires_at, createdAt: quote.created_at };
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
      requireFinance(ctx, ['orders:read']);
      return exclusive(storageId, async () => {
        const intent = journal.read()[storageId];
        if (intent.resourceId) return publicIntent(await reconcileRead(ctx, journal, storageId, intent));
        if (!['PREPARED', 'UNKNOWN'].includes(intent.status)) return publicIntent(intent);
        requireFinance(ctx, ['orders:write']);
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
