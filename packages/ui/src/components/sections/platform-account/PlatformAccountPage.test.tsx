import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PlatformCommerceState, PlatformCommerceIntent } from '@/lib/platformCommerce';
import { z } from 'zod';

const browser = new Window({ url: 'http://localhost/' });
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Element: browser.Element, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent, KeyboardEvent: browser.KeyboardEvent, DocumentFragment: browser.DocumentFragment, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true })) {
  savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const signedIn = {
  status: 'signed-in', user: { id: 'actor-a', name: 'Alice', email: 'alice@example.test' },
  accounts: [{ id: 'team-a', kind: 'team', name: 'Team A', role: 'member' }], accountId: 'team-a', expiresAt: '2026-10-24T15:00:00Z',
  membership: [{ id: 'sub-a', product_id: 'superwagie', status: 'active', paid_through: '2026-11-24T00:00:00Z', offer: { name: 'Fixture plan' } }],
  credits: { available: '9007199254740993', reserved: '7' }, consoleUrl: 'http://localhost:8088/?account=team-a', modelService: 'unavailable',
};
const profile = { id: 'actor-a', username: 'alice', displayName: 'Alice', email: 'alice@example.test', avatarAvailable: false, version: '1' };
let profileFail = false;
const profileWrites: Array<{ displayName: string }> = [];
const passwordWrites: Array<{ currentPassword: string; newPassword: string }> = [];
let avatarWrites = 0;
let identityUser: typeof signedIn.user | null = null;
let failed = false; let readCount = 0; let logoutCount = 0; let modelEnabled = false; let reconcileCount = 0; let unboundTask = false; let scopeRestart = false;
const taskState = { sessionID: 'ses-platform', taskID: 'task-a', actorID: 'actor-a', accountID: 'team-a', model: 'fixture-model', blocked: true, calls: [{ callID: 'call-a', status: 'UNKNOWN' }] };
let authSignedOut = false;
let registrationUnknown = true;
let registrationPasswordRequired = false;
let lostRegistrationResponse = false;
let expiredAccount = false;
let lostLogoutResponse = false;
let registrationLimited = false;
let financialAccess = false;
let lostRechargeResponse = false;
let passwordRequests = 0;
let rechargeRequests = 0;
let settlementRequests = 0;
let purchaseRequests = 0;
let nextAccountResponse: Promise<Response> | null = null;
let rechargeResponseGate: Promise<void> | null = null;
let commerceReads = 0;
const registrationBodies: Array<{ username: string; password?: string; idempotencyKey: string; displayName?: string }> = [];
const rechargeKeys: string[] = [];
const commerce: PlatformCommerceState = {
  accountId: 'team-a', role: 'owner', financialAccess: true, missingScopes: [],
  payments: { mode: 'sandbox', canRecharge: true, canPurchase: true },
  wallets: [{ productId: 'superwagie', asset: 'CNY/6', amount: '9007199254740993' }, { productId: 'llmrouter', asset: 'CNY/6', amount: '0' }],
  offers: [{ id: 'addon-a', productId: 'llmrouter', name: 'Fixture credits', accountKind: 'both', kind: 'addon', period: 'once', price: '10000000', monthlyCredit: '20000000', validityMonths: 12, rank: 1, sandbox: true }],
  orders: [], intents: [], rechargeHistoryScope: 'this-instance',
};
const bodySchema = z.object({ username: z.string().optional(), password: z.string().optional(), idempotencyKey: z.string().optional(), productId: z.string().optional(), amount: z.string().optional(), accountId: z.string().optional(), offerId: z.string().optional() });
const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const path = String(input instanceof Request ? input.url : input);
  if (path.endsWith('/api/platform-account/profile')) {
    if (profileFail) return Response.json({ error: 'platform_unavailable' }, { status: 503 });
    if (init?.method === 'PATCH') {
      const body = z.object({ displayName: z.string() }).parse(JSON.parse(String(init.body)));
      profileWrites.push(body); profile.displayName = body.displayName;
    }
    return Response.json(profile);
  }
  if (path.endsWith('/api/platform-account/password')) {
    passwordWrites.push(z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(JSON.parse(String(init?.body))));
    return Response.json({ status: 'signed-out' });
  }
  if (path.endsWith('/api/platform-account/avatar')) {
    if (init?.method === 'PUT') { avatarWrites += 1; profile.avatarAvailable = true; return Response.json(profile); }
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  }
  if (path.endsWith('/api/platform-account/session')) return Response.json(authSignedOut ? { status: 'signed-out' } : expiredAccount ? { status: 'expired' } : { status: 'signed-in', user: identityUser ?? signedIn.user, expiresAt: signedIn.expiresAt });
  if (path.endsWith('/api/platform-account/auth-methods')) return Response.json({ passwordLogin: true, registration: true, browserLogin: false, passwordRecoveryUrl: 'https://unihub.example.test/forget' });
  if (path.endsWith('/api/platform-account/register')) {
    const body = z.object({ username: z.string(), password: z.string().optional(), idempotencyKey: z.string(), displayName: z.string().optional() }).parse(JSON.parse(String(init?.body)));
    registrationBodies.push(body);
    if (lostRegistrationResponse) { lostRegistrationResponse = false; throw new TypeError('network'); }
    if (registrationPasswordRequired && !body.password) return Response.json({ error: 'platform_registration_password_required' }, { status: 400 });
    if (registrationLimited) return Response.json({ error: 'rate_limited' }, { status: 429 });
    return Response.json({ registrationId: 'reg-a', status: registrationUnknown ? 'UNKNOWN' : 'CREATED', loginRequired: !registrationUnknown });
  }
  if (path.endsWith('/api/platform-account/password-login')) { passwordRequests++; authSignedOut = false; return Response.json(signedIn); }
  if (path.endsWith('/api/platform-account/commerce/recharges')) {
    const body = bodySchema.parse(JSON.parse(String(init?.body)));
    rechargeRequests++; rechargeKeys.push(body.idempotencyKey ?? '');
    const intent: PlatformCommerceIntent = { idempotencyKey: body.idempotencyKey ?? '', kind: 'recharge', accountId: 'team-a', productId: body.productId ?? '', amount: body.amount ?? '', status: 'PENDING', resourceId: 'recharge-a', createdAt: '2026-10-25T00:00:00Z' };
    if (!commerce.intents.some((item) => item.idempotencyKey === intent.idempotencyKey)) commerce.intents.push(intent);
    if (rechargeResponseGate) await rechargeResponseGate;
    if (lostRechargeResponse) { lostRechargeResponse = false; throw new TypeError('network'); }
    return Response.json(intent);
  }
  if (path.endsWith('/sandbox-settle')) {
    settlementRequests++;
    const intent = commerce.intents[0];
    if (!intent) throw new Error('Expected recharge');
    intent.status = 'APPLIED';
    const wallet = commerce.wallets?.find((item) => item.productId === intent.productId);
    if (wallet) wallet.amount = (BigInt(wallet.amount) + BigInt(intent.amount)).toString();
    return Response.json(intent);
  }
  if (path.endsWith('/api/platform-account/commerce/purchases')) {
    purchaseRequests++;
    const body = bodySchema.parse(JSON.parse(String(init?.body)));
    const intent: PlatformCommerceIntent = { idempotencyKey: body.idempotencyKey ?? '', kind: 'purchase', accountId: 'team-a', productId: 'llmrouter', amount: '10000000', status: 'APPLIED', createdAt: '2026-10-25T00:00:00Z' };
    commerce.intents.push(intent); return Response.json(intent);
  }
  if (path.endsWith('/api/platform-account/commerce')) { commerceReads++; return Response.json(financialAccess ? commerce : { ...commerce, financialAccess: false, role: 'member', wallets: null, orders: null, intents: [], payments: { mode: 'sandbox', canRecharge: false, canPurchase: false } }); }
  if (path.includes('/api/platform-model/sessions/')) {
    if (scopeRestart) return Response.json({error:'platform_model_scope_restart_required'}, {status:403});
    if (path.endsWith('/reconcile')) { reconcileCount += 1; expect(init?.method).toBe('POST'); return Response.json({ ...taskState, blocked: false, calls: [{ callID: 'call-a', status: 'SETTLED', charged: '80' }] }); }
    return unboundTask ? Response.json({ error: 'platform_task_unbound' }, { status: 403 }) : Response.json(taskState);
  }
  if (path.includes('/api/platform-account/logout')) { if (lostLogoutResponse) { lostLogoutResponse = false; throw new TypeError('network'); } authSignedOut = true; logoutCount += 1; expect(init?.method).toBe('POST'); return Response.json({ status: 'signed-out' }); }
  if (path.includes('/api/platform-account')) { readCount += 1; if (nextAccountResponse) { const response = nextAccountResponse; nextAccountResponse = null; return response; } if (expiredAccount) return Response.json({ error: 'platform_session_expired' }, { status: 401 }); return failed ? Response.json({ error: 'platform_unavailable' }, { status: 502 }) : Response.json(authSignedOut ? { status: 'signed-out' } : { ...signedIn, modelService: modelEnabled ? 'available' : 'unavailable' }); }
  if (path.endsWith('/fs/home')) return Response.json({ home: '/fixture' });
  if (path.endsWith('/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
  return Response.json([]);
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../../web/src/api/index');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { PlatformAccountPage } = await import('./PlatformAccountPage');
const { preparePlatformAccountTarget, usePlatformAccountTabStore } = await import('./platformAccountTabs');
let root: Root; let host: HTMLDivElement;
const render = async (vscode = false, initialTab: 'billing' | 'profile' | 'usage' = 'billing') => {
  usePlatformAccountTabStore.getState().setTab(initialTab);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const apis = createWebAPIs();
  await act(async () => root.render(<RuntimeAPIContext.Provider value={{ ...apis, runtime: { ...apis.runtime, isVSCode: vscode } }}><I18nProvider><PlatformAccountPage /></I18nProvider></RuntimeAPIContext.Provider>));
  if (!vscode && host.querySelector('[role="tab"]')) await tab(initialTab === 'usage' ? 'Usage' : initialTab === 'profile' ? 'Personal details' : 'Membership and recharge');
};
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); profileFail = false; profile.displayName = 'Alice'; profile.avatarAvailable = false; profileWrites.length = 0; passwordWrites.length = 0; avatarWrites = 0; identityUser = null; failed = false; readCount = 0; logoutCount = 0; reconcileCount = 0; modelEnabled = false; unboundTask = false; scopeRestart = false; taskState.calls[0].status = 'UNKNOWN'; signedIn.credits.available = '9007199254740993'; authSignedOut = false; registrationUnknown = true; registrationPasswordRequired = false; lostRegistrationResponse = false; registrationLimited = false; expiredAccount = false; lostLogoutResponse = false; financialAccess = false; lostRechargeResponse = false; passwordRequests = 0; rechargeRequests = 0; settlementRequests = 0; purchaseRequests = 0; registrationBodies.length = 0; rechargeKeys.length = 0; nextAccountResponse = null; rechargeResponseGate = null; commerceReads = 0; commerce.intents = []; commerce.orders = []; if (commerce.offers) commerce.offers = commerce.offers.filter((offer) => offer.id === 'addon-a'); if (commerce.wallets) commerce.wallets = commerce.wallets.filter((wallet) => wallet.productId); if (commerce.wallets?.[1]) commerce.wallets[1].amount = '0'; localStorage.clear(); useSessionUIStore.setState({ currentSessionId: null }); });
afterAll(async () => { fetchFixture.mockRestore(); await browser.happyDOM.close(); for (const [name, descriptor] of savedGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });

const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
const tab = async (text: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing tab ${text}`);
  await act(async () => found.click());
};
const fill = async (id: string, value: string) => {
  const field = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!field) throw new Error(`Missing input ${id}`);
  await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
};
const submit = async () => {
  const form = host.querySelector('form');
  if (!form) throw new Error('Missing form');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};
const chooseOffer = async (name = 'Fixture credits') => {
  const option = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.getAttribute('aria-label') === name);
  if (!option) throw new Error(`Missing offer option ${name}`);
  await act(async () => option.click());
};
describe('PlatformAccountPage', () => {
  test('explains a model writer lock without claiming another instance is stopped', async () => {
    useI18nStore.getState().setLocale('en');
    nextAccountResponse = Promise.resolve(Response.json({ ...signedIn, modelUnavailableReason: 'platform_store_busy' }));
    await render();
    expect(host.textContent).toContain('another instance may be running');
    expect(host.textContent).toContain('all processes using the same data directory');
    expect(host.textContent).toContain('state.json');
    expect(host.textContent).toContain('unihub-model/writer.lock');
    expect(host.textContent).toContain('only after confirming');
    await tab('Personal details');
    expect(host.textContent).toContain('another instance may be running');
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    expect(host.textContent).toContain('其他实例可能仍在运行');
    expect(host.textContent).toContain('共享同一数据目录的所有进程');
    expect(host.textContent).toContain('确认全部退出后');
  });
  test('distinguishes an unavailable locking dependency from a lock conflict', async () => {
    useI18nStore.getState().setLocale('en');
    nextAccountResponse = Promise.resolve(Response.json({ ...signedIn, modelUnavailableReason: 'platform_store_lock_unavailable' }));
    await render();
    expect(host.textContent).toContain('locking support is unavailable');
    expect(host.textContent).not.toContain('delete unihub-model/writer.lock');
  });
  test('keeps account details visible for an unfamiliar model failure reason', async () => {
    useI18nStore.getState().setLocale('en');
    nextAccountResponse = Promise.resolve(Response.json({ ...signedIn, modelUnavailableReason: 'future_reason' }));
    await render();
    expect(host.textContent).toContain('Platform models are not enabled');
    expect(host.textContent).toContain('Fixture plan');
    expect(host.textContent).not.toContain('locking support is unavailable');
  });
  test('shows personal details while a financial account read fails', async () => {
    useI18nStore.getState().setLocale('en'); failed = true; await render(false, 'profile');
    expect(host.querySelector<HTMLInputElement>('#unihub-profile-username')?.value).toBe('alice');
    expect(host.querySelector<HTMLInputElement>('#unihub-profile-username')?.readOnly).toBe(true);
    expect(host.querySelector('#unihub-new-password')).not.toBeNull();
    expect(host.textContent).not.toContain('9007199254.740993');
  });
  test('updates only the display name while the login username stays fixed', async () => {
    useI18nStore.getState().setLocale('en'); await render(false, 'profile');
    await fill('unihub-profile-display-name', 'New display name');
    await submit();
    expect(profileWrites).toEqual([{ displayName: 'New display name' }]);
    expect(host.querySelector<HTMLInputElement>('#unihub-profile-username')?.value).toBe('alice');
    expect(host.querySelector<HTMLInputElement>('#unihub-profile-display-name')?.value).toBe('New display name');
  });
  test('keeps profile read failure visible without inventing an empty profile', async () => {
    useI18nStore.getState().setLocale('en'); profileFail = true; await render(false, 'profile');
    expect(host.querySelector('#unihub-profile-username')).toBeNull();
    expect(host.textContent).toContain('Could not read');
    expect(profileWrites).toHaveLength(0);
  });
  test('clears every password field before rejecting mismatched confirmation', async () => {
    useI18nStore.getState().setLocale('en'); await render(false, 'profile');
    await fill('unihub-current-password', 'OriginalPassword123');
    await fill('unihub-new-password', 'DifferentPassword123');
    await fill('unihub-confirm-password', 'OtherPassword123');
    const form = host.querySelector('#unihub-new-password')?.closest('form');
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(passwordWrites).toHaveLength(0);
    expect(host.textContent).toContain('new passwords do not match');
    for (const id of ['unihub-current-password', 'unihub-new-password', 'unihub-confirm-password']) expect(host.querySelector<HTMLInputElement>(`#${id}`)?.value).toBe('');
  });
  test('sends the current and new password once and clears credential inputs', async () => {
    useI18nStore.getState().setLocale('en'); await render(false, 'profile');
    await fill('unihub-current-password', 'OriginalPassword123');
    await fill('unihub-new-password', 'DifferentPassword123');
    await fill('unihub-confirm-password', 'DifferentPassword123');
    const form = host.querySelector('#unihub-new-password')?.closest('form');
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(passwordWrites).toEqual([{ currentPassword: 'OriginalPassword123', newPassword: 'DifferentPassword123' }]);
    for (const id of ['unihub-current-password', 'unihub-new-password', 'unihub-confirm-password']) expect(host.querySelector<HTMLInputElement>(`#${id}`)?.value).toBe('');
  });
  test('rejects oversized or non-image avatars before an upload request', async () => {
    useI18nStore.getState().setLocale('en'); await render(false, 'profile');
    for (const file of [new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' }), new File(['text'], 'file.txt', { type: 'text/plain' })]) {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('Avatar input missing');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    }
    expect(avatarWrites).toBe(0);
    expect(host.textContent).toContain('no larger than 512 KiB');
  });

  test('loads uploaded avatar bytes and revokes its object URL on leaving the profile', async () => {
    useI18nStore.getState().setLocale('en'); await render(false, 'profile');
    const revoke = spyOn(URL, 'revokeObjectURL');
    try {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('Avatar input missing');
      Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([137, 80, 78, 71])], 'avatar.png', { type: 'image/png' })], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      expect(avatarWrites).toBe(1);
      const image = host.querySelector<HTMLImageElement>('img[alt="Avatar"]');
      expect(image?.src.startsWith('blob:')).toBe(true);
      const objectURL = image?.src;
      await tab('Membership and recharge');
      expect(revoke.mock.calls.some(([value]) => value === objectURL)).toBe(true);
    } finally { revoke.mockRestore(); }
  });

  test('does not upload a selected avatar into a new runtime after its file read finishes', async () => {
    useI18nStore.getState().setLocale('en'); await render(false, 'profile');
    let complete: (value: ArrayBuffer) => void = () => { throw new Error('File read missing'); };
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'avatar.png', { type: 'image/png' });
    const read = spyOn(file, 'arrayBuffer').mockImplementation(() => new Promise<ArrayBuffer>((resolve) => { complete = resolve; }));
    try {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error('Avatar input missing');
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://avatar-runtime.test', runtimeKey: 'test-avatar-runtime' }));
      await act(async () => complete(new Uint8Array([137, 80, 78, 71]).buffer));
      expect(avatarWrites).toBe(0);
    } finally { read.mockRestore(); }
  });

  test('opens personal details for an avatar search result while another tab is selected', async () => {
    useI18nStore.getState().setLocale('en'); await render(false, 'billing');
    expect(host.querySelector('input[type="file"]')).toBeNull();
    await act(async () => preparePlatformAccountTarget('platform-account.avatar'));
    expect(host.querySelector('input[type="file"]')).not.toBeNull();
  });

  test('renders membership and integer credit units and signs out independently', async () => {
    useI18nStore.getState().setLocale('en'); await render();
    expect(host.textContent).toContain('Alice'); expect(host.textContent).toContain('Fixture plan'); expect(host.textContent).toContain('9007199254.740993');
    expect(host.querySelector('[data-settings-item="platform-account.account"]')).not.toBeNull();
    const logout = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Sign out');
    expect(logout).toBeDefined(); await act(async () => logout?.click());
    expect(logoutCount).toBe(1); expect(host.textContent).not.toContain('9007199254.740993'); expect(host.textContent).toContain('Sign in');
  });
  test('shows a signed-in identity label when the profile name and email are empty', async () => {
    useI18nStore.getState().setLocale('en');
    identityUser = { ...signedIn.user, name: '', email: '' };
    nextAccountResponse = Promise.resolve(Response.json({ ...signedIn, user: identityUser }));
    await render();
    expect(host.querySelector('[data-settings-item="platform-account.login"]')?.textContent).toContain('Signed in');
    expect(button('Sign out')).toBeDefined();
  });
  test('clears prior account data after a failed refresh', async () => {
    useI18nStore.getState().setLocale('en'); await render(); failed = true;
    const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh');
    await act(async () => refresh?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not read'); expect(host.textContent).not.toContain('9007199254.740993');
  });
  test('recovers from a lost logout request without reporting that the account is signed out', async () => {
    useI18nStore.getState().setLocale('en'); await render(); lostLogoutResponse = true;
    await act(async () => button('Sign out').click());
    expect(host.textContent).not.toContain('Alice'); expect(host.querySelector('[data-settings-item="platform-account.login"]')?.textContent).toContain('Could not read');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not read');
    await act(async () => button('Refresh').click()); expect(host.textContent).toContain('Alice');
    await act(async () => button('Sign out').click()); expect(host.textContent).toContain('Sign in'); expect(logoutCount).toBe(1);
  });
  test('formats CREDIT/6 exactly and renders the selected account name and kind', async () => {
    useI18nStore.getState().setLocale('en'); signedIn.credits.available = '2999920'; await render();
    expect(host.textContent).toContain('2.999920'); expect(host.textContent).toContain('0.000007');
    const picker = host.querySelector('[aria-label="Billing account"]');
    expect(picker?.textContent).toContain('Team A'); expect(picker?.textContent).toContain('Team'); expect(picker?.textContent).not.toContain('team-a');
  });
  test('shows enabled model status and reconciles an unknown call without model generation', async () => {
    useI18nStore.getState().setLocale('en'); modelEnabled = true; useSessionUIStore.setState({ currentSessionId: 'ses-platform' }); await render(false, 'usage');
    expect(host.textContent).toContain('Account-wide token usage is not connected'); expect(host.textContent).toContain('Outcome unknown'); expect(host.textContent).toContain('Team A');
    expect(host.textContent).not.toContain('not enabled');
    const reconcile = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Check settlement status');
    expect(reconcile).toBeDefined(); await act(async () => reconcile?.click());
    expect(reconcileCount).toBe(1); expect(host.textContent).toContain('Settled'); expect(host.textContent).not.toContain('Outcome unknown');
  });
  test('explains when account changes require restarting SuperWagie', async () => {
    useI18nStore.getState().setLocale('en'); modelEnabled = true; scopeRestart = true;
    useSessionUIStore.setState({ currentSessionId: 'ses-platform' }); await render(false, 'usage');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Restart SuperWagie');
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('重启 SuperWagie');
  });
  test('clears the previous task when reconciliation requires a restart', async () => {
    useI18nStore.getState().setLocale('en'); modelEnabled = true;
    useSessionUIStore.setState({ currentSessionId: 'ses-platform' }); await render(false, 'usage');
    expect(host.textContent).toContain('Outcome unknown'); scopeRestart = true;
    await act(async () => button('Check settlement status').click());
    expect(host.textContent).toContain('Restart SuperWagie'); expect(host.textContent).not.toContain('Outcome unknown');
  });
  test('shows pending settlement while the task remains blocked', async () => {
    useI18nStore.getState().setLocale('en'); modelEnabled = true; taskState.calls[0].status = 'DELIVERED'; useSessionUIStore.setState({ currentSessionId: 'ses-platform' }); await render(false, 'usage');
    expect(host.textContent).toContain('Awaiting settlement'); expect(host.textContent).toContain('unsettled call'); expect(host.textContent).not.toContain('Outcome unknown');
  });
  test('omits task details for an unbound session without reporting a failure', async () => {
    useI18nStore.getState().setLocale('en'); modelEnabled = true; unboundTask = true; useSessionUIStore.setState({ currentSessionId: 'ses-unbound' }); await render(false, 'usage');
    expect(host.textContent).toContain('Account-wide token usage is not connected'); expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.textContent).not.toContain('Check settlement status');
  });
  test('shows translated unsupported state and makes no account request in VS Code', async () => {
    await render(true); await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    expect(host.textContent).toContain('暂不支持'); expect(readCount).toBe(0); expect(host.querySelector('[data-settings-item="platform-account.login"]')).not.toBeNull();
  });
  test('recovers uncertain registration with its original key and no password across remount', async () => {
    useI18nStore.getState().setLocale('en'); authSignedOut = true; await render();
    await act(async () => button('Create account').click());
    await fill('unihub-username', 'new-account'); await fill('unihub-password', 'SyntheticPassword9!'); await submit();
    expect(registrationBodies).toHaveLength(1); expect(registrationBodies[0]?.password).toBe('SyntheticPassword9!');
    expect(host.querySelector<HTMLInputElement>('#unihub-password')?.value).toBe('');
    expect(JSON.stringify([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i) ?? '')))).not.toContain('SyntheticPassword9!');
    await act(async () => root.unmount()); host.remove(); await render();
    expect(host.textContent).toContain('Registration outcome is unknown');
    registrationLimited = true; await submit();
    expect(host.textContent).toContain('Too many attempts');
    expect(button('Check original registration')).toBeDefined();
    registrationLimited = false;
    registrationUnknown = false; await submit();
    expect(registrationBodies).toHaveLength(3); expect(registrationBodies[1]?.idempotencyKey).toBe(registrationBodies[0]?.idempotencyKey); expect(registrationBodies[2]?.idempotencyKey).toBe(registrationBodies[0]?.idempotencyKey);
    expect(registrationBodies[1]?.password).toBeUndefined(); expect(registrationBodies[2]?.password).toBeUndefined(); expect(host.textContent).toContain('Account created');
    expect(passwordRequests).toBe(0);
    await fill('unihub-password', 'SyntheticPassword9!'); await submit();
    expect(passwordRequests).toBe(1); expect(host.textContent).toContain('Alice'); expect(host.querySelector('#unihub-password')).toBeNull();
  });
  test('recovers a browser-lost registration with the same key after passwordless recovery requires the password', async () => {
    useI18nStore.getState().setLocale('en'); authSignedOut = true; lostRegistrationResponse = true; registrationUnknown = false; await render();
    await act(async () => button('Create account').click());
    await fill('unihub-username', 'new-account'); await fill('unihub-password', 'SyntheticPassword9!'); await fill('unihub-display-name', 'Display'); await submit();
    expect(registrationBodies).toHaveLength(1); expect(registrationBodies[0]?.password).toBe('SyntheticPassword9!');
    await act(async () => root.unmount()); host.remove(); await render();
    registrationPasswordRequired = true; await submit();
    expect(host.textContent).toContain('Re-enter the password from your original registration');
    expect(host.querySelector<HTMLInputElement>('#unihub-password')?.disabled).toBe(false);
    expect([...host.querySelectorAll('button')].find((item) => item.textContent === 'Create account' && item.type === 'submit')).toBeDefined();
    await fill('unihub-password', 'SyntheticPassword9!');
    expect(JSON.stringify([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i) ?? '')))).not.toContain('SyntheticPassword9!');
    await act(async () => root.unmount()); host.remove(); await render();
    expect(host.querySelector<HTMLInputElement>('#unihub-password')?.value).toBe(''); expect(host.querySelector<HTMLInputElement>('#unihub-password')?.disabled).toBe(true);
    await submit(); expect(registrationBodies[2]?.password).toBeUndefined();
    await fill('unihub-password', 'SyntheticPassword9!'); registrationPasswordRequired = false; await submit();
    expect(registrationBodies).toHaveLength(4);
    expect(registrationBodies[1]?.idempotencyKey).toBe(registrationBodies[0]?.idempotencyKey);
    expect(registrationBodies[2]?.idempotencyKey).toBe(registrationBodies[0]?.idempotencyKey);
    expect(registrationBodies[3]?.idempotencyKey).toBe(registrationBodies[0]?.idempotencyKey);
    expect(registrationBodies[1]?.password).toBeUndefined(); expect(registrationBodies[3]?.password).toBe('SyntheticPassword9!');
    expect(registrationBodies[3]?.username).toBe('new-account'); expect(registrationBodies[3]?.displayName).toBe('Display'); expect(host.textContent).toContain('Account created');
  });
  test('shows the sign-in form when the platform session has expired', async () => {
    useI18nStore.getState().setLocale('en'); expiredAccount = true; await render();
    expect(host.textContent).toContain('Your account session expired'); expect(host.querySelector('#unihub-username')).not.toBeNull();
    expect(button('Forgot password?')).toBeDefined();
  });
  test('opens the UniHub password recovery page from the sign-in form', async () => {
    useI18nStore.getState().setLocale('en'); expiredAccount = true; await render();
    const open = spyOn(browser, 'open').mockImplementation(() => null);
    try {
      await act(async () => button('Forgot password?').click());
      expect(open.mock.calls[0]).toEqual(['https://unihub.example.test/forget', '_blank', 'noopener,noreferrer']);
    } finally { open.mockRestore(); }
  });
  test('rejects an oversized registration password before creating the registration intent', async () => {
    useI18nStore.getState().setLocale('en'); authSignedOut = true; await render();
    await act(async () => button('Create account').click());
    await fill('unihub-username', 'new-account'); await fill('unihub-password', `${'a'.repeat(71)}é`); await submit();
    expect(host.textContent).toContain('password does not meet the registration rules');
    expect(registrationBodies).toHaveLength(0); expect(localStorage.length).toBe(0);
  });
  test('accepts a registration password at 72 UTF-8 bytes', async () => {
    useI18nStore.getState().setLocale('en'); authSignedOut = true; registrationUnknown = false; await render();
    await act(async () => button('Create account').click());
    await fill('unihub-username', 'new-account'); await fill('unihub-password', `${'a'.repeat(70)}é`); await submit();
    expect(registrationBodies[0]?.password).toBe(`${'a'.repeat(70)}é`); expect(host.textContent).toContain('Account created');
  });
  test('retains login compatibility for passwords longer than 72 UTF-8 bytes', async () => {
    useI18nStore.getState().setLocale('en'); authSignedOut = true; await render();
    await fill('unihub-username', 'new-account'); await fill('unihub-password', `${'a'.repeat(71)}é`); await submit();
    expect(passwordRequests).toBe(1); expect(host.textContent).toContain('Alice');
  });
  test('limits the registration display name to 80 Unicode code points', async () => {
    useI18nStore.getState().setLocale('en'); authSignedOut = true; await render();
    await act(async () => button('Create account').click());
    await fill('unihub-display-name', '😀'.repeat(81));
    expect(host.querySelector<HTMLInputElement>('#unihub-display-name')?.value).toBe('😀'.repeat(80));
    await fill('unihub-username', 'new-account'); await fill('unihub-password', 'SyntheticPassword9!'); await submit();
    expect(registrationBodies[0]?.displayName).toBe('😀'.repeat(80));
  });
  test('keeps financial controls restricted while members can read credits', async () => {
    useI18nStore.getState().setLocale('en'); await render();
    expect(host.textContent).toContain('billing administrator'); expect(host.textContent).toContain('9007199254.740993');
    expect(host.querySelector('#unihub-recharge-amount')).toBeNull(); expect(rechargeRequests).toBe(0); expect(settlementRequests).toBe(0);
  });
  test('requires separate sandbox settlement and purchase after funding the selected product wallet', async () => {
    useI18nStore.getState().setLocale('en'); financialAccess = true; await render();
    expect(host.textContent).toContain('CNY 9007199254.740993');
    await chooseOffer();
    expect(button('Buy Fixture credits for CNY 10.00').disabled).toBe(true);
    await act(async () => button('Fill recharge for this offer').click());
    expect(host.querySelector<HTMLInputElement>('#unihub-recharge-amount')?.value).toBe('10.00');
    await submit(); expect(rechargeRequests).toBe(1); expect(settlementRequests).toBe(0); expect(purchaseRequests).toBe(0);
    expect(commerce.intents[0]?.productId).toBe('llmrouter');
    await act(async () => button('Simulate settlement').click());
    expect(settlementRequests).toBe(1); expect(purchaseRequests).toBe(0);
    expect(button('Buy Fixture credits for CNY 10.00').disabled).toBe(false);
    await act(async () => button('Buy Fixture credits for CNY 10.00').click()); expect(purchaseRequests).toBe(1);
  });
  test('recovers a lost recharge response using the same key without starting another request', async () => {
    useI18nStore.getState().setLocale('en'); financialAccess = true; lostRechargeResponse = true; await render();
    await fill('unihub-recharge-amount', '5.00'); await submit();
    expect(host.textContent).toContain('request outcome is unknown'); expect(host.textContent).not.toContain('CNY 9007199254.740993');
    await act(async () => button('Recover original request').click());
    expect(rechargeKeys).toHaveLength(2); expect(rechargeKeys[1]).toBe(rechargeKeys[0]); expect(commerce.intents).toHaveLength(1);
    expect(settlementRequests).toBe(0); expect(purchaseRequests).toBe(0);
  });

  test('drops a late account read after switching the runtime endpoint', async () => {
    useI18nStore.getState().setLocale('en');
    let resolveOld = (_value: Response) => {};
    nextAccountResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    await render(); authSignedOut = true;
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://other-runtime.test', runtimeKey: 'test-other-runtime' }));
    expect(host.textContent).toContain('Sign in');
    await act(async () => resolveOld(Response.json(signedIn)));
    expect(host.textContent).not.toContain('Alice'); expect(host.textContent).not.toContain('9007199254.740993');
  });
  test('drops a pending recharge result after sign-out and never refreshes the old account', async () => {
    useI18nStore.getState().setLocale('en'); financialAccess = true; await render();
    let release = () => {};
    rechargeResponseGate = new Promise<void>((resolve) => { release = resolve; });
    await fill('unihub-recharge-amount', '5.00'); await submit();
    expect(rechargeRequests).toBe(1);
    expect(host.textContent).toContain('Loading');
    expect(host.textContent).not.toContain('Unconfirmed request');
    expect(host.textContent).not.toContain('request outcome is unknown');
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Recover original request')).toBe(false);
    await act(async () => button('Sign out').click());
    await act(async () => release());
    expect(commerceReads).toBe(1); expect(host.textContent).not.toContain('Simulate settlement'); expect(host.textContent).toContain('Sign in');
  });

  test('separates monthly and annual memberships from addons and clears hidden purchase selections', async () => {
    useI18nStore.getState().setLocale('en'); financialAccess = true;
    commerce.offers?.push(
      { id: 'monthly-plan', productId: 'superwagie', name: 'Monthly plan', accountKind: 'both', kind: 'membership', period: 'month', price: '19000000', monthlyCredit: '7000000', validityMonths: 0, rank: 1, sandbox: true },
      { id: 'annual-plan', productId: 'superwagie', name: 'Annual plan', accountKind: 'both', kind: 'membership', period: 'year', price: '190000000', monthlyCredit: '7000000', validityMonths: 0, rank: 1, sandbox: true },
    );
    await render();
    const membershipGroup = host.querySelector('[role="radiogroup"][aria-label="Membership subscription"]');
    expect(membershipGroup?.textContent).toContain('CNY 19.00 / month');
    expect(membershipGroup?.textContent).toContain('7.000000 credits each month');
    expect(membershipGroup?.textContent).not.toContain('Fixture credits');
    expect(host.querySelector('[role="radiogroup"][aria-label="Credit add-ons"]')?.textContent).toContain('CNY 10.00 once');
    expect(host.textContent).toContain('credits are issued monthly');
    await chooseOffer('Monthly plan');
    await act(async () => button('Annual').click());
    expect(host.querySelector('[role="radiogroup"][aria-label="Membership subscription"]')?.textContent).toContain('CNY 190.00 / year, paid in full');
    expect(host.querySelector('[role="radio"][aria-label="Monthly plan"]')).toBeNull();
    expect([...host.querySelectorAll('button')].some((item) => item.textContent === 'Buy Monthly plan for CNY 19.00')).toBe(false);
    await chooseOffer('Annual plan');
    expect(button('Buy Annual plan for CNY 190.00').disabled).toBe(true);
    await chooseOffer();
    expect(host.querySelector('[role="radio"][aria-label="Annual plan"]')?.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('[role="radio"][aria-label="Fixture credits"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => button('Monthly').click());
    expect(button('Buy Fixture credits for CNY 10.00')).toBeDefined();
    expect(purchaseRequests).toBe(0); expect(rechargeRequests).toBe(0);
    await act(async () => { useI18nStore.getState().setLocale('zh-CN'); await import('@/lib/i18n/messages/zh-CN'); });
    expect(host.textContent).toContain('会员订阅'); expect(host.textContent).toContain('加量包');
    expect(button('月付')).toBeDefined(); expect(button('年付')).toBeDefined();
    expect(host.textContent).toContain('人民币 19.00 元 / 月');
    expect(host.textContent).toContain('有效期 12 个月');
    expect(host.querySelector('[role="radio"][aria-label="Fixture credits"]')?.getAttribute('aria-checked')).toBe('true');
  });

  test('shows an empty selected billing period while keeping addons available', async () => {
    useI18nStore.getState().setLocale('en'); financialAccess = true; await render();
    await act(async () => button('Annual').click());
    expect(host.textContent).toContain('No membership offers are published for this billing period.');
    expect(host.querySelector('[role="radiogroup"][aria-label="Credit add-ons"]')?.textContent).toContain('Fixture credits');
    expect(purchaseRequests).toBe(0);
  });

  test('shows annual membership billing and translated order states without a zero-month term', async () => {
    useI18nStore.getState().setLocale('en'); financialAccess = true;
    commerce.offers?.push({ id: 'membership-a', productId: 'superwagie', name: 'Annual membership', accountKind: 'both', kind: 'membership', period: 'year', price: '100000000', monthlyCredit: '20000000', validityMonths: 0, rank: 1, sandbox: true });
    commerce.wallets?.push({ productId: '', asset: 'CNY/6', amount: '1230000' });
    commerce.orders?.push({ id: 'order-a', productId: 'superwagie', offerName: 'Annual membership', amount: '100000000', paymentStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refundStatus: '' });
    await render(); await act(async () => button('Annual').click()); await chooseOffer('Annual membership');
    expect(host.textContent).toContain('Billing period'); expect(host.textContent).toContain('Monthly model credit grant');
    expect(host.textContent).not.toContain('0 months'); expect(host.textContent).toContain('Unified wallet');
    expect(host.textContent).toContain('Payment: Paid · Fulfillment: Fulfilled · Refund: None');
    expect(button('Buy Annual membership for CNY 100.00').disabled).toBe(true);
  });

});
