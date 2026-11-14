import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import {
  loginMobileOfficial, logoutMobileOfficial, readMobileOfficialProjects, readMobileOfficialSession,
  selectMobileOfficialAccount, MobileOfficialError, type MobileOfficialSession,
} from '@/lib/guests/mobile-official';
import { MobileOfficialView } from './MobileOfficialView';

type SignedIn = Extract<MobileOfficialSession, { status: 'signed-in' }>;
type Gate = { kind: 'checking' } | { kind: 'failed' } | { kind: 'ready'; session: MobileOfficialSession };
const SelectedProjects: React.FC<{ owner: string; requestedProject: string | null }> = ({ owner, requestedProject }) => {
  const { t } = useI18n();
  const [projects, setProjects] = React.useState<{ id: string; name: string }[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true; const isCurrent = captureRuntimeInstance();
    void readMobileOfficialProjects().then(({ projects: next }) => {
      if (!active || !isCurrent()) return;
      setProjects(next);
      setProjectId(requestedProject === null ? next[0]?.id ?? null : next.some((project) => project.id === requestedProject) ? requestedProject : null);
    }).catch(() => { if (active && isCurrent()) setFailed(true); });
    return () => { active = false; };
  }, [requestedProject]);
  if (failed) return <p role="status" className="p-4">{t('mobile.official.readFailed')}</p>;
  if (!projects) return <p role="status" className="p-4">{t('common.loading')}</p>;
  if (!projects.length) return <p className="p-4">{t('mobile.official.empty')}</p>;
  return <>
    <nav className="flex shrink-0 gap-2 overflow-x-auto px-4" aria-label={t('mobile.official.sourceProject', { project: '' })}>
      {projects.map((project) => <Button key={project.id} variant="chip" aria-pressed={projectId === project.id} onClick={() => setProjectId(project.id)}>{project.name}</Button>)}
    </nav>
    <MobileOfficialView key={`${owner}:${projectId ?? ''}`} visible projectId={projectId} ownerKey={owner} authority="pilot" />
  </>;
};

/** An isolated product-login namespace mounts only the selected-material reader. */
export const MobileOfficialEntry: React.FC<{ requestedProject: string | null }> = ({ requestedProject }) => {
  const { t } = useI18n();
  const [gate, setGate] = React.useState<Gate>({ kind: 'checking' });
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [loginFailed, setLoginFailed] = React.useState(false);
  const generation = React.useRef({ value: 0 });
  const identityPending = React.useRef(false);
  const refresh = React.useCallback(async () => {
    const revision = ++generation.current.value; const isCurrent = captureRuntimeInstance();
    setGate({ kind: 'checking' });
    try {
      const session = await readMobileOfficialSession();
      if (isCurrent() && generation.current.value === revision) setGate({ kind: 'ready', session });
    } catch { if (isCurrent() && generation.current.value === revision) setGate({ kind: 'failed' }); }
  }, []);
  React.useEffect(() => {
    const owner = generation.current;
    void refresh();
    const retire = subscribeRuntimeEndpointWillChange(() => { generation.current.value++; identityPending.current = false; setBusy(false); setPassword(''); setGate({ kind: 'checking' }); });
    const changed = subscribeRuntimeEndpointChanged(() => { void refresh(); });
    const focus = () => { if (!identityPending.current) void refresh(); };
    window.addEventListener('focus', focus);
    return () => { owner.value++; retire(); changed(); window.removeEventListener('focus', focus); };
  }, [refresh]);
  const signedIn: SignedIn | null = gate.kind === 'ready' && gate.session.status === 'signed-in' ? gate.session : null;
  React.useEffect(() => {
    if (!signedIn) return;
    const timeout = setTimeout(() => { void refresh(); }, Math.max(0, Math.min(Date.parse(signedIn.expiresAt) - Date.now(), 2_147_483_647)));
    return () => clearTimeout(timeout);
  }, [refresh, signedIn]);
  const mutateIdentity = async (operation: () => Promise<MobileOfficialSession>, signingIn = false) => {
    if (busy) return;
    const revision = ++generation.current.value; const isCurrent = captureRuntimeInstance();
    identityPending.current = true; setBusy(true); setLoginFailed(false); setGate({ kind: 'checking' });
    try {
      const session = await operation();
      if (isCurrent() && revision === generation.current.value) setGate({ kind: 'ready', session });
    } catch (cause) {
      if (isCurrent() && revision === generation.current.value) {
        const rejected = signingIn && cause instanceof MobileOfficialError && cause.status >= 400 && cause.status < 500;
        setGate(rejected ? { kind: 'ready', session: { status: 'signed-out' } } : { kind: 'failed' }); setLoginFailed(rejected);
      }
    } finally { if (isCurrent() && revision === generation.current.value) { identityPending.current = false; setPassword(''); setBusy(false); } }
  };
  const owner = signedIn ? JSON.stringify([getRuntimeKey(), signedIn.user.id, signedIn.accountId, generation.current.value]) : '';
  return <main className="flex h-full min-h-0 flex-col overflow-auto bg-background text-foreground" aria-label={t('mobile.official.readOnly')}>
    <header className="flex shrink-0 items-center justify-between gap-2 p-4">
      <h1 className="min-w-0 truncate typography-ui-label">{t('mobile.official.title')}</h1>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>{t('mobile.official.refresh')}</Button>
        {signedIn ? <Button variant="ghost" disabled={busy} onClick={() => void mutateIdentity(logoutMobileOfficial)}>{t('platformAccount.signOut')}</Button> : null}
      </div>
    </header>
    {gate.kind === 'checking' ? <p role="status" className="p-4">{t('common.loading')}</p> : null}
    {gate.kind === 'failed' ? <p role="status" className="p-4">{t('mobile.official.readFailed')}</p> : null}
    {gate.kind === 'ready' && !signedIn ? <section className="mx-auto w-full max-w-sm p-4">
      <h2 className="typography-ui-label">{t('platformAccount.loginRequired')}</h2>
      <p className="mt-2 typography-meta text-muted-foreground">{t('mobile.official.readOnly')}</p>
      {gate.session.status === 'unsupported' || gate.session.status === 'unconfigured' ? <p role="status" className="mt-4">{t('platformAccount.unconfigured')}</p> :
        <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void mutateIdentity(() => loginMobileOfficial(username, password), true); }}>
          <label className="block typography-meta" htmlFor="mobile-official-username">{t('platformAccount.username')}</label>
          <Input id="mobile-official-username" autoComplete="username" maxLength={64} required value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} />
          <label className="block typography-meta" htmlFor="mobile-official-password">{t('platformAccount.password')}</label>
          <Input id="mobile-official-password" autoComplete="current-password" type="password" maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          <Button type="submit" className="w-full" disabled={busy}>{t('platformAccount.signIn')}</Button>
          <p className="min-h-5 truncate typography-meta text-[var(--status-error-text)]" role="status" title={loginFailed ? t('platformAccount.error.login') : undefined}>{loginFailed ? t('platformAccount.error.login') : ''}</p>
        </form>}
    </section> : null}
    {signedIn ? <>
      <nav className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-3" aria-label={t('platformAccount.account')}>
        {signedIn.accounts.map((account) => <Button key={account.id} variant="chip" aria-pressed={signedIn.accountId === account.id} onClick={() => void mutateIdentity(() => selectMobileOfficialAccount(account.id))}>{account.name}</Button>)}
      </nav>
      <SelectedProjects key={owner} owner={owner} requestedProject={requestedProject} />
    </> : null}
  </main>;
};
