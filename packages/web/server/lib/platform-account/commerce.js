import crypto from 'node:crypto';
import { z } from 'zod';
import { PlatformAccountError } from './runtime.js';
import { openCommerceStore } from './commerce-store.js';

const id = z.string().min(1).max(200);
const units = z.string().regex(/^(0|[1-9]\d*)$/);
const product = z.enum(['superwagie', 'llmrouter']);
const key = z.string().uuid();
const accountInput = z.object({ accountId: id }).strict();
const rechargeInput = accountInput.extend({ productId: product, amount: units, idempotencyKey: key });
const purchaseInput = accountInput.extend({ offerId: id, idempotencyKey: key });
const accountsSchema = z.array(z.object({ id, kind: z.enum(['personal', 'team']), role: z.string() }));
const capabilitySchema = z.object({ product_id: z.literal('superwagie'), scopes: z.array(z.string()), sandbox: z.boolean(), product_wallet_recharge: z.boolean(), real_payments_configured: z.boolean() });
const walletSchema = z.object({ product_id: z.string(), asset: z.literal('CNY/6'), amount: units });
const subscriptionsSchema = z.array(z.object({ product_id: z.string(), status: z.string(), paid_through: z.string().datetime() }));
const resourcesSchema = z.object({ account_id: id, wallets: z.array(walletSchema).optional(), as_of: z.string() });
const offerSchema = z.object({
  id, product_id: z.string(), name: z.string(), account_kind: z.enum(['personal', 'team', 'both']),
  kind: z.enum(['membership', 'addon']), period: z.string(), price: units, monthly_credit: units,
  validity_months: z.number().int().nonnegative(), rank: z.number().int().nonnegative(), sandbox: z.boolean(), status: z.string(),
});
const orderSchema = z.object({
  id, account_id: id, actor_id: id, product_id: z.string(), offer: offerSchema, amount: units,
  payment_status: z.string(), fulfillment_status: z.string(), refund_status: z.string().optional(),
});
const rechargeSchema = z.object({ id, account_id: id, product_id: product, amount: units, currency: z.literal('CNY'), operation_id: id.nullish() });
const operationSchema = z.object({ id, account_id: id, kind: z.literal('recharge'), status: z.enum(['CREATED', 'SUBMITTING', 'UNKNOWN', 'APPLIED', 'REJECTED']), error_code: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/).optional() });
const requiredScopes = ['catalog:read', 'subscriptions:read', 'wallets:read', 'orders:read', 'recharges:read', 'recharges:write', 'orders:write', 'operations:read'];
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
const supportedOffer = (offer) => (offer.product_id === 'superwagie' && offer.kind === 'membership') || (offer.product_id === 'llmrouter' && offer.kind === 'addon');
const publicOffer = (offer) => ({ id: offer.id, productId: offer.product_id, name: offer.name, accountKind: offer.account_kind, kind: offer.kind, period: offer.period, price: offer.price, monthlyCredit: offer.monthly_credit, validityMonths: offer.validity_months, rank: offer.rank, sandbox: offer.sandbox });
const publicOrder = (order) => ({ id: order.id, productId: order.product_id, offerName: order.offer.name, amount: order.amount, paymentStatus: order.payment_status, fulfillmentStatus: order.fulfillment_status, refundStatus: order.refund_status ?? '' });
const publicIntent = (intent) => ({ idempotencyKey: intent.idempotencyKey, kind: intent.kind, accountId: intent.accountId, productId: intent.productId, amount: intent.amount, offerId: intent.offerId, resourceId: intent.resourceId, status: intent.status, errorCode: intent.errorCode, createdAt: intent.createdAt });
const intentId = (session, accountId, idempotencyKey) => crypto.createHash('sha256').update(JSON.stringify([session.serviceId, session.actingUserId, accountId, idempotencyKey])).digest('hex');
const safeError = (error) => error instanceof PlatformAccountError && /^[a-z][a-z0-9_]{0,100}$/.test(error.code) ? error.code : 'platform_commerce_unavailable';
const rejectedCodes = new Set(['invalid_request', 'forbidden', 'insufficient_funds', 'insufficient_credits', 'not_found', 'unsupported_plan_change', 'payment_not_configured']);

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
    .filter((offer) => supportedOffer(offer) && offer.sandbox && offer.status === 'published' && (offer.account_kind === 'both' || offer.account_kind === ctx.account.kind));
  const readOrders = async (ctx) => {
    const orders = parse(z.array(orderSchema), await ctx.session.request(pathFor(ctx.account.id, 'orders')));
    if (orders.some((order) => order.account_id !== ctx.account.id || order.product_id !== order.offer.product_id)) fail('platform_response_invalid', 502);
    return orders.filter((order) => supportedOffer(order.offer));
  };
  const mutateIntent = async (journal, storageId, values) => journal.mutate((intents) => {
    const intent = intents[storageId];
    if (!intent) fail('platform_intent_not_found', 404);
    Object.assign(intent, values, { updatedAt: new Date(now()).toISOString() });
    return structuredClone(intent);
  });
  const operationStatus = (operation) => operation.status === 'APPLIED' ? 'APPLIED' : operation.status === 'REJECTED' ? 'FAILED' : 'PENDING';
  const readRecharge = async (ctx, intent) => {
    const recharge = parse(rechargeSchema, await ctx.session.request(pathFor(intent.accountId, `recharges/${segment(intent.resourceId)}`)));
    if (recharge.id !== intent.resourceId || recharge.account_id !== intent.accountId || recharge.product_id !== intent.productId || recharge.amount !== intent.amount) fail('platform_response_invalid', 502);
    if (!recharge.operation_id) return { resourceId: recharge.id, status: 'PENDING', errorCode: undefined };
    const operation = parse(operationSchema, await ctx.session.request(pathFor(intent.accountId, `operations/${segment(recharge.operation_id)}`)));
    if (operation.id !== recharge.operation_id || operation.account_id !== intent.accountId) fail('platform_response_invalid', 502);
    return { resourceId: recharge.id, operationId: operation.id, status: operationStatus(operation), errorCode: operation.error_code || undefined };
  };
  const orderValues = (intent, order) => {
    if (order.account_id !== intent.accountId || order.actor_id !== intent.actorId || order.product_id !== intent.productId || order.offer.id !== intent.offerId || order.amount !== intent.amount) fail('platform_response_invalid', 502);
    return { resourceId: order.id, status: order.payment_status === 'PAID' && order.fulfillment_status === 'FULFILLED' ? 'APPLIED' : 'PENDING', errorCode: undefined };
  };
  const reconcileRead = async (ctx, journal, storageId, intent) => {
    if (!intent.resourceId) return intent;
    let values;
    if (intent.kind === 'recharge') values = await readRecharge(ctx, intent);
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
      if (intent.kind === 'recharge') {
        init.body = JSON.stringify({ product_id: intent.productId, amount: intent.amount });
        const recharge = parse(rechargeSchema, await ctx.session.request(pathFor(intent.accountId, 'recharges'), init));
        if (recharge.account_id !== intent.accountId || recharge.product_id !== intent.productId || recharge.amount !== intent.amount) fail('platform_response_invalid', 502);
        values = { resourceId: recharge.id, status: 'PENDING', errorCode: undefined };
      } else {
        init.body = JSON.stringify({ offer_id: intent.offerId });
        const order = parse(orderSchema, await ctx.session.request(pathFor(intent.accountId, 'orders'), init));
        values = orderValues(intent, order);
      }
      return mutateIntent(journal, storageId, values);
    } catch (error) {
      const errorCode = safeError(error);
      return mutateIntent(journal, storageId, { status: rejectedCodes.has(errorCode) ? 'FAILED' : 'UNKNOWN', errorCode });
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
  const createIntent = async (ctx, body, kind, offer) => {
    const journal = await store();
    const storageId = intentId(ctx.session, body.accountId, body.idempotencyKey);
    return exclusive(storageId, async () => {
      if (!journal.read()[storageId] && offer?.kind === 'membership') {
        requireFinance(ctx, ['subscriptions:read']);
        const subscriptions = parse(subscriptionsSchema, await ctx.session.request(pathFor(body.accountId, 'subscriptions')));
        if (subscriptions.some((subscription) => subscription.product_id === 'superwagie' && subscription.status === 'active' && Date.parse(subscription.paid_through) > now())) fail('platform_membership_active', 409);
      }
      const intent = {
        serviceId: ctx.session.serviceId, actorId: ctx.session.actingUserId, accountId: body.accountId,
        idempotencyKey: body.idempotencyKey, kind, productId: offer?.product_id ?? body.productId,
        amount: offer?.price ?? body.amount,
        status: 'PREPARED', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
      };
      if (offer) intent.offerId = offer.id;
      const { value, created } = await journal.mutate((intents) => {
        const existing = intents[storageId];
        if (existing) {
          if (existing.kind !== intent.kind || existing.productId !== intent.productId || existing.amount !== intent.amount || existing.offerId !== intent.offerId) fail('platform_idempotency_conflict', 409);
          return { value: structuredClone(existing), created: false };
        }
        const unresolved = Object.values(intents).find((item) => item.serviceId === intent.serviceId && item.actorId === intent.actorId && item.accountId === intent.accountId && ['PREPARED', 'UNKNOWN'].includes(item.status));
        if (unresolved) {
          if (!hasScopes(ctx.capabilities, [unresolved.kind === 'recharge' ? 'recharges:read' : 'orders:read'])) fail('platform_scope_required', 403);
          fail('platform_operation_pending', 409);
        }
        intents[storageId] = intent;
        return { value: structuredClone(intent), created: true };
      });
      return publicIntent(created ? await dispatch(ctx, journal, storageId, value) : value);
    }, JSON.stringify([kind, offer?.product_id ?? body.productId, offer?.price ?? body.amount, offer?.id]));
  };
  const findIntent = async (ctx, idempotencyKey) => {
    parse(key, idempotencyKey, 'platform_request_invalid');
    const journal = await store();
    const storageId = intentId(ctx.session, ctx.account.id, idempotencyKey);
    const intent = journal.read()[storageId];
    if (!intent) fail('platform_intent_not_found', 404);
    return { journal, storageId };
  };
  const assertRecharge = (ctx) => {
    requireFinance(ctx, ['recharges:read', 'recharges:write', 'operations:read']);
    if (!ctx.capabilities.sandbox || !ctx.capabilities.product_wallet_recharge) fail('payment_not_configured', 503);
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
      const intents = journal ? Object.values(journal.read()).filter((intent) => intent.serviceId === ctx.session.serviceId && intent.actorId === ctx.session.actingUserId && intent.accountId === ctx.account.id && hasScopes(ctx.capabilities, [intent.kind === 'recharge' ? 'recharges:read' : 'orders:read'])).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicIntent) : [];
      return {
        accountId: ctx.account.id, role: ctx.account.role, financialAccess: finance,
        missingScopes: requiredScopes.filter((scope) => !ctx.capabilities.scopes.includes(scope)),
        payments: { mode: ctx.capabilities.sandbox ? 'sandbox' : 'unconfigured', canRecharge: finance && ctx.capabilities.sandbox && ctx.capabilities.product_wallet_recharge && hasScopes(ctx.capabilities, ['recharges:read', 'recharges:write', 'operations:read']), canPurchase: finance && ctx.capabilities.sandbox && hasScopes(ctx.capabilities, ['orders:read', 'orders:write', 'catalog:read']) },
        wallets: resources ? resources.wallets.map((wallet) => ({ productId: wallet.product_id, asset: wallet.asset, amount: wallet.amount })) : null,
        offers: offers?.map(publicOffer) ?? null, orders: orders?.map(publicOrder) ?? null, intents,
        rechargeHistoryScope: 'this-instance',
      };
    },
    createRecharge: async (identity, rawBody) => {
      const body = parse(rechargeInput, rawBody, 'platform_request_invalid');
      if (BigInt(body.amount) <= 0n || BigInt(body.amount) > 9_223_372_036_854_775_807n || BigInt(body.amount) % 10_000n !== 0n) fail('platform_amount_invalid');
      const ctx = await context(identity, body.accountId);
      assertRecharge(ctx);
      return createIntent(ctx, body, 'recharge');
    },
    purchase: async (identity, rawBody) => {
      const body = parse(purchaseInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      requireFinance(ctx, ['catalog:read', 'orders:read', 'orders:write']);
      if (!ctx.capabilities.sandbox) fail('payment_not_configured', 503);
      const offer = (await catalog(ctx)).find((item) => item.id === body.offerId);
      if (!offer) fail('platform_offer_unavailable', 404);
      return createIntent(ctx, body, 'purchase', offer);
    },
    reconcile: async (identity, idempotencyKey, rawBody) => {
      const body = parse(accountInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      const { journal, storageId } = await findIntent(ctx, idempotencyKey);
      const selectedIntent = journal.read()[storageId];
      requireFinance(ctx, selectedIntent.kind === 'recharge' ? ['recharges:read', 'operations:read'] : ['orders:read']);
      return exclusive(storageId, async () => {
        const intent = journal.read()[storageId];
        if (intent.resourceId) return publicIntent(await reconcileRead(ctx, journal, storageId, intent));
        if (!['PREPARED', 'UNKNOWN'].includes(intent.status)) return publicIntent(intent);
        if (intent.kind === 'recharge') assertRecharge(ctx);
        else {
          requireFinance(ctx, ['orders:write']);
          if (!ctx.capabilities.sandbox) fail('payment_not_configured', 503);
        }
        return publicIntent(await dispatch(ctx, journal, storageId, intent));
      });
    },
    sandboxSettle: async (identity, idempotencyKey, rawBody) => {
      const body = parse(accountInput, rawBody, 'platform_request_invalid');
      const ctx = await context(identity, body.accountId);
      assertRecharge(ctx);
      const { journal, storageId } = await findIntent(ctx, idempotencyKey);
      return exclusive(storageId, async () => {
        const intent = journal.read()[storageId];
        if (intent.kind !== 'recharge' || !intent.resourceId) fail('platform_recharge_unresolved', 409);
        const before = await reconcileRead(ctx, journal, storageId, intent);
        if (before.operationId || before.status === 'APPLIED') return publicIntent(before);
        await mutateIntent(journal, storageId, { status: 'UNKNOWN', errorCode: undefined });
        try {
          const operation = parse(operationSchema, await ctx.session.request(pathFor(intent.accountId, `recharges/${segment(intent.resourceId)}/sandbox-settle`), { method: 'POST' }));
          if (operation.account_id !== intent.accountId) fail('platform_response_invalid', 502);
          return publicIntent(await mutateIntent(journal, storageId, { operationId: operation.id, status: operationStatus(operation), errorCode: operation.error_code || undefined }));
        } catch (error) {
          return publicIntent(await mutateIntent(journal, storageId, { status: 'UNKNOWN', errorCode: safeError(error) }));
        }
      });
    },
    close: async () => {
      closing = true;
      await Promise.allSettled([...active.values()].map((entry) => entry.promise));
      if (storePromise) await (await storePromise).close();
    },
  };
};
