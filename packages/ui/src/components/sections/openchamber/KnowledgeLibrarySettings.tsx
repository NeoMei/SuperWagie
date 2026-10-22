import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SETTINGS_HELPER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  KnowledgeLibraryError,
  provisionKnowledgeLibrary,
  readKnowledgeLibraryStatus,
  rebuildKnowledgeLibraryIndex,
  reconnectKnowledgeLibrary,
  type KnowledgeLibraryStatus,
} from '@/lib/knowledgeLibrary';
import { useUIStore } from '@/stores/useUIStore';

// The backend is a child process: starting, retrying and first-run
// provisioning all take a moment, so the status is read again until it settles.
const STATUS_POLL_MS = 2_000;

type StatusView = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; status: KnowledgeLibraryStatus };
type Action = 'retry' | 'provision' | 'rebuild';

/**
 * Settings → Knowledge library. The backend, the model key that provisions it
 * and the index, in one section: they are one topic and one switch, and the
 * panel that adds folders lives beside the chat.
 */
export const KnowledgeLibrarySettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.knowledgeLibraryEnabled);
  const setEnabled = useUIStore((state) => state.setKnowledgeLibraryEnabled);

  const [view, setView] = React.useState<StatusView>({ kind: 'loading' });
  const [modelKey, setModelKey] = React.useState('');
  const [busy, setBusy] = React.useState<Action | null>(null);
  const [failure, setFailure] = React.useState<{ action: Action; code: string } | null>(null);

  const load = React.useCallback((signal?: AbortSignal) => (
    readKnowledgeLibraryStatus(signal).then(
      (status) => { if (!signal?.aborted) setView({ kind: 'ready', status }); return status; },
      () => { if (!signal?.aborted) setView({ kind: 'error' }); return null; },
    )
  ), []);

  // Read until the backend settles. A stopped backend stays stopped until the
  // switch or a retry changes it, so polling ends there.
  React.useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      void load(controller.signal).then((status) => {
        if (controller.signal.aborted || !status) return;
        if (status.backend.state === 'starting') timer = setTimeout(poll, STATUS_POLL_MS);
      });
    };
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, load]);

  const run = React.useCallback(async (action: Action, work: () => Promise<void>) => {
    setBusy(action);
    setFailure(null);
    try {
      await work();
      await load();
    } catch (error) {
      setFailure({ action, code: error instanceof KnowledgeLibraryError ? error.code : 'request_failed' });
    } finally {
      setBusy(null);
    }
  }, [load]);

  const status = view.kind === 'ready' ? view.status : null;
  const supported = status?.supported !== false;
  const running = status?.backend.state === 'running';
  const provisioned = status?.provisioned === true;
  const showKeyForm = Boolean(status?.supported && running && !provisioned);

  let statusText: string;
  if (view.kind === 'loading') statusText = t('knowledgeLibrary.status.starting');
  else if (view.kind === 'error') statusText = t('knowledgeLibrary.status.error');
  else {
    const { state, port } = view.status.backend;
    statusText =
      state === 'running' ? t('knowledgeLibrary.status.running', { port })
      : state === 'starting' ? t('knowledgeLibrary.status.starting')
      : state === 'not-installed' ? t('knowledgeLibrary.status.notInstalled')
      : state === 'port-conflict' ? t('knowledgeLibrary.status.portConflict', { port })
      : state === 'unavailable' ? t('knowledgeLibrary.status.unavailable')
      : t('knowledgeLibrary.status.stopped');
  }

  let failureText = '';
  if (failure?.action === 'provision') {
    failureText = failure.code === 'provision_account_failed'
      ? t('knowledgeLibrary.panel.error.generic', { code: failure.code })
      : t('knowledgeLibrary.key.failed', { code: failure.code });
  }
  else if (failure?.action === 'rebuild') failureText = t('knowledgeLibrary.index.failed', { code: failure.code });
  else if (failure) failureText = t('knowledgeLibrary.status.error');

  return (
    <SettingsSection
      title={t('knowledgeLibrary.status.title')}
      divider={false}
      settingsItem="knowledge-library.backend"
      info={status?.backend.logPath ?? undefined}
    >
      <SettingsCheckboxRow
        settingsItem="knowledge-library.enabled"
        checked={enabled}
        onChange={setEnabled}
        disabled={!supported}
        label={t('knowledgeLibrary.enabled.label')}
        ariaLabel={t('knowledgeLibrary.enabled.label')}
        info={t('knowledgeLibrary.enabled.info')}
      />

      <div className="flex items-center gap-2">
        <span className={SETTINGS_HELPER_CLASS} aria-live="polite">{statusText}</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          disabled={!supported || busy !== null}
          onClick={() => void run('retry', reconnectKnowledgeLibrary)}
        >
          {busy === 'retry' ? t('knowledgeLibrary.actions.working') : t('knowledgeLibrary.actions.retry')}
        </Button>
      </div>

      {status?.stats ? (
        <p className={SETTINGS_HELPER_CLASS}>
          {t('knowledgeLibrary.panel.stats', {
            libraries: status.stats.libraries,
            indexable: status.stats.indexable,
            skipped: status.stats.skipped,
            failed: status.indexing?.failed ?? 0,
          })}
        </p>
      ) : null}

      {showKeyForm ? (
        <SettingsControlGroup
          settingsItem="knowledge-library.key"
          title={t('knowledgeLibrary.key.title')}
          description={t('knowledgeLibrary.key.description')}
        >
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={modelKey}
              onChange={(event) => setModelKey(event.target.value)}
              placeholder={t('knowledgeLibrary.key.placeholder')}
              aria-label={t('knowledgeLibrary.key.label')}
              className="max-w-[24rem]"
            />
            <Button
              type="button"
              size="xs"
              disabled={busy !== null || modelKey.trim().length === 0}
              onClick={() => void run('provision', async () => {
                await provisionKnowledgeLibrary(modelKey.trim());
                setModelKey('');
              })}
            >
              {busy === 'provision' ? t('knowledgeLibrary.actions.working') : t('knowledgeLibrary.actions.activate')}
            </Button>
          </div>
        </SettingsControlGroup>
      ) : null}

      <SettingsFieldRow
        settingsItem="knowledge-library.rebuild"
        label={t('knowledgeLibrary.index.title')}
        description={t('knowledgeLibrary.index.description')}
      >
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="!font-normal"
          disabled={!provisioned || !running || busy !== null}
          onClick={() => void run('rebuild', rebuildKnowledgeLibraryIndex)}
        >
          {busy === 'rebuild' ? t('knowledgeLibrary.actions.working') : t('knowledgeLibrary.actions.rebuild')}
        </Button>
      </SettingsFieldRow>

      <p className={SETTINGS_HELPER_CLASS} aria-live="polite">{failureText}</p>
    </SettingsSection>
  );
};
