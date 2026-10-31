import React from 'react';
import type { FormField, FormValue } from '@opencode/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Spinner } from '@/components/ui/spinner';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { opencodeClient, type OpenCodeClient } from '@/lib/opencode/client';
import { getIntegrationClient } from '@/lib/opencode/integration-catalog';
import {
  collectFieldAnswer,
  defaultFieldValues,
  describeOAuthError,
  extractUserCode,
  fieldLabel,
  firstUnansweredField,
  isAnswerableField,
  shouldOpenAuthorizationUrl,
  type OAuthAttempt,
} from './provider-oauth';
import { ProviderFormFields } from './ProviderFormFields';
import type { SignInMethod } from './providerAuth';

interface ProviderOAuthMethodsProps {
  /** The integration that owns these methods; it shares the provider's id. */
  integrationId: string;
  methods: SignInMethod[];
  /** Called once a credential has been stored, so the caller can reload providers. */
  onConnected: () => void | Promise<void>;
  /**
   * Location the integration belongs to. An MCP server's OAuth integration
   * exists only in the Location whose config declares the server, so its
   * requests must resolve that directory. Without one, requests go where the
   * integration list is read (`getIntegrationClient`).
   */
  directory?: string | null;
  /** Layout only — the caller owns separation from whatever sits above. */
  className?: string;
  /** Start the only sign-in method on mount, for a sign-in the user just asked for elsewhere. */
  autoStart?: boolean;
  /** Off when a surrounding card already names the method. */
  showMethodLabels?: boolean;
  /** The start button's text, when the surface has a more specific word than "Connect". */
  connectLabel?: string;
  /** Off when the caller starts the sign-in from its own button; only the attempt's progress and errors show. */
  showStartButton?: boolean;
}

interface ConnectOwner {
  client: OpenCodeClient;
  integrationID: string;
  attemptID: string | null;
}

const cancelOwnedAttempt = (owner: ConnectOwner): void => {
  if (!owner.attemptID) return;
  void owner.client.integration.oauth.cancel({ integrationID: owner.integrationID, attemptID: owner.attemptID })
    .catch(() => undefined);
};

type Flow =
  | { phase: 'idle' }
  | { phase: 'prompting'; methodID: string; fields: FormField[]; error: string | null }
  | { phase: 'connecting'; methodID: string }
  /** `auto`: the attempt is polled until the browser sign-in finishes. */
  | { phase: 'waiting'; methodID: string; owner: ConnectOwner; attempt: OAuthAttempt }
  /** `code`: waiting for the user to paste a code out of the browser. */
  | { phase: 'awaitingCode'; methodID: string; owner: ConnectOwner; attempt: OAuthAttempt; submitting: boolean }
  | { phase: 'failed'; methodID: string; message: string };

const IDLE: Flow = { phase: 'idle' };

/** How often an `auto` attempt is re-checked while the user signs in. */
const STATUS_POLL_INTERVAL_MS = 1500;

/**
 * Sign-in for a provider's OAuth and external-credential methods.
 *
 * For OAuth, the mode reported by `integration.oauth.connect` drives
 * everything: `auto` polls `integration.oauth.status` until the attempt
 * completes, `code` collects a pasted code and calls
 * `integration.oauth.complete`. See `provider-oauth.ts`. An external method
 * (an Azure CLI login, an AWS profile) only needs its form answered:
 * `integration.connect.external` stores a reference to credentials managed
 * outside OpenCode, so there is no attempt to follow.
 *
 * Only one method can run at a time, and an abandoned attempt is cancelled
 * upstream on unmount so it cannot linger until it expires. Mount this with
 * `key={integrationId}` so switching providers starts from a clean flow.
 */
export const ProviderOAuthMethods: React.FC<ProviderOAuthMethodsProps> = ({
  integrationId,
  methods,
  onConnected,
  directory,
  className,
  autoStart = false,
  showMethodLabels = true,
  connectLabel,
  showStartButton = true,
}) => {
  const { t } = useI18n();
  const [flow, setFlow] = React.useState<Flow>(IDLE);
  const [fieldValues, setFieldValues] = React.useState<Record<string, FormValue>>({});
  const [codeInput, setCodeInput] = React.useState('');
  // Each request resolves its client when it begins. Its identity also retires
  // pending responses when the form's explicit location changes or unmounts.
  const activeOwnerRef = React.useRef<ConnectOwner | null>(null);
  const autoStartedRef = React.useRef(false);
  React.useEffect(() => {
    setFlow(IDLE);
    return () => {
      const owner = activeOwnerRef.current;
      activeOwnerRef.current = null;
      autoStartedRef.current = false;
      if (owner) cancelOwnedAttempt(owner);
    };
  }, [directory, integrationId]);

  const activeMethodID = flow.phase === 'idle' ? null : flow.methodID;
  const busy = flow.phase === 'connecting'
    || flow.phase === 'waiting'
    || (flow.phase === 'awaitingCode' && flow.submitting);

  const copy = async (value: string, successKey: I18nKey, failureKey: I18nKey) => {
    const result = await copyTextToClipboard(value);
    if (result.ok) {
      toast.success(t(successKey));
      return;
    }
    console.error('Failed to copy OAuth value:', result.error);
    toast.error(t(failureKey));
  };

  const succeed = async (owner: ConnectOwner, successKey: I18nKey = 'settings.providers.page.toast.oauthCompleted') => {
    if (activeOwnerRef.current !== owner) return;
    activeOwnerRef.current = null;
    setFlow(IDLE);
    toast.success(t(successKey));
    await onConnected();
  };

  const fail = (owner: ConnectOwner, methodID: string, error: unknown, fallbackKey: I18nKey) => {
    if (activeOwnerRef.current !== owner) return;
    activeOwnerRef.current = null;
    console.error('OAuth flow failed:', error);
    setFlow({ phase: 'failed', methodID, message: describeOAuthError(error, t, fallbackKey) });
  };

  /**
   * Polls an `auto` attempt to completion. Never throws: the user already has
   * control in the browser, so a failure here is a flow state, not an exception
   * to unwind. Stops as soon as the attempt is no longer the active one, which
   * is how cancel and unmount tear it down.
   */
  const pollAttempt = async (owner: ConnectOwner, methodID: string, attemptID: string) => {
    while (activeOwnerRef.current === owner) {
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
      if (activeOwnerRef.current !== owner) return;
      try {
        const { data: status } = await owner.client.integration.oauth.status({ integrationID: owner.integrationID, attemptID });
        if (activeOwnerRef.current !== owner) return;
        if (status.status === 'complete') {
          await succeed(owner);
          return;
        }
        if (status.status === 'failed') {
          setFlow({ phase: 'failed', methodID, message: status.message });
          activeOwnerRef.current = null;
          return;
        }
      } catch (error) {
        if (activeOwnerRef.current !== owner) return;
        fail(owner, methodID, error, 'settings.providers.page.toast.oauthCompleteFailed');
        return;
      }
    }
  };

  const runExternalConnect = async (owner: ConnectOwner, methodID: string, answer: Record<string, FormValue>) => {
    setFlow({ phase: 'connecting', methodID });
    try {
      // OpenCode refuses an answer for a method without a form, even an empty one.
      await owner.client.integration.connect.external({
        integrationID: owner.integrationID,
        methodID,
        answer: Object.keys(answer).length > 0 ? answer : undefined,
      });
    } catch (error) {
      fail(owner, methodID, error, 'settings.providers.page.toast.externalConnectFailed');
      return;
    }
    await succeed(owner, 'settings.providers.page.toast.externalConnected');
  };

  const runConnect = async (method: SignInMethod, answer: Record<string, FormValue>) => {
    const owner: ConnectOwner = {
      client: directory ? opencodeClient.getScopedSdkClient(directory) : getIntegrationClient(),
      integrationID: integrationId,
      attemptID: null,
    };
    activeOwnerRef.current = owner;
    if (method.type === 'external') {
      await runExternalConnect(owner, method.id, answer);
      return;
    }
    setFlow({ phase: 'connecting', methodID: method.id });

    let attempt: OAuthAttempt;
    try {
      const { data } = await owner.client.integration.oauth.connect({
        integrationID: owner.integrationID,
        methodID: method.id,
        ...(Object.keys(answer).length > 0 ? { answer } : {}),
      });
      attempt = { attemptID: data.attemptID, mode: data.mode, url: data.url, instructions: data.instructions };
    } catch (error) {
      fail(owner, method.id, error, 'settings.providers.page.toast.oauthStartFailed');
      return;
    }

    owner.attemptID = attempt.attemptID;
    if (activeOwnerRef.current !== owner) {
      cancelOwnedAttempt(owner);
      return;
    }

    // Claude Code CLI owns its OAuth flow and opens the browser itself. Its
    // integration URL is informational only; opening it creates a misleading
    // docs tab alongside the real sign-in page.
    if (shouldOpenAuthorizationUrl(integrationId, attempt.url)) {
      void openExternalUrl(attempt.url);
    }

    if (attempt.mode === 'code') {
      setCodeInput('');
      setFlow({ phase: 'awaitingCode', methodID: method.id, owner, attempt, submitting: false });
      return;
    }

    setFlow({ phase: 'waiting', methodID: method.id, owner, attempt });
    await pollAttempt(owner, method.id, attempt.attemptID);
  };

  const beginConnect = (method: SignInMethod) => {
    const fields = (method.form ?? []).filter(isAnswerableField);
    if (fields.length === 0) {
      void runConnect(method, {});
      return;
    }
    setFieldValues(defaultFieldValues(fields));
    setFlow({ phase: 'prompting', methodID: method.id, fields, error: null });
  };

  React.useEffect(() => {
    if (!autoStart || autoStartedRef.current || methods.length !== 1) return;
    autoStartedRef.current = true;
    beginConnect(methods[0]);
    // Once per form location: a later render cannot restart a cancelled sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, directory, integrationId, methods]);

  const submitFields = (method: SignInMethod) => {
    if (flow.phase !== 'prompting') {
      return;
    }
    const unanswered = firstUnansweredField(flow.fields, fieldValues);
    if (unanswered) {
      setFlow({
        ...flow,
        error: t('settings.providers.page.auth.oauth.promptRequired', { field: fieldLabel(unanswered) }),
      });
      return;
    }
    void runConnect(method, collectFieldAnswer(flow.fields, fieldValues));
  };

  const submitCode = async () => {
    if (flow.phase !== 'awaitingCode') {
      return;
    }
    const code = codeInput.trim();
    if (!code) {
      return;
    }
    const { methodID, owner, attempt } = flow;
    if (activeOwnerRef.current !== owner) return;
    setFlow({ ...flow, submitting: true });
    try {
      await owner.client.integration.oauth.complete({
        integrationID: owner.integrationID,
        attemptID: attempt.attemptID,
        code,
      });
      await succeed(owner);
    } catch (error) {
      fail(owner, methodID, error, 'settings.providers.page.toast.oauthCompleteFailed');
    }
  };

  /** Drops the attempt upstream so a half-finished sign-in cannot be resumed by accident. */
  const cancel = () => {
    const owner = activeOwnerRef.current;
    activeOwnerRef.current = null;
    if (owner) cancelOwnedAttempt(owner);
    setFlow(IDLE);
  };

  const renderAttemptDetails = (attempt: OAuthAttempt) => {
    const userCode = extractUserCode(attempt.instructions);
    return (
      <>
        {attempt.instructions && (
          <p className="typography-meta text-[var(--status-info-text)] bg-[var(--status-info-background)] px-2 py-1.5 rounded">
            {attempt.instructions}
          </p>
        )}

        {userCode && (
          <div className="flex items-center gap-2">
            <Input
              value={userCode}
              readOnly
              aria-label={t('settings.providers.page.auth.oauth.deviceCodeLabel')}
              className="font-mono text-center tracking-widest"
            />
            <Button
              variant="outline"
              size="xs"
              className="!font-normal shrink-0"
              onClick={() => void copy(
                userCode,
                'settings.providers.page.toast.deviceCodeCopied',
                'settings.providers.page.toast.deviceCodeCopyFailed',
              )}
            >
              {t('settings.providers.page.actions.copyCode')}
            </Button>
          </div>
        )}

        {attempt.url && (
          <div className="flex items-center gap-2">
            <Input
              value={attempt.url}
              readOnly
              aria-label={t('settings.providers.page.auth.oauth.linkLabel')}
              className="text-xs text-muted-foreground"
            />
            <div className="flex gap-1 shrink-0">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => void openExternalUrl(attempt.url)}
              >
                {t('settings.providers.page.actions.open')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => void copy(
                  attempt.url,
                  'settings.providers.page.toast.oauthLinkCopied',
                  'settings.providers.page.toast.oauthLinkCopyFailed',
                )}
              >
                {t('settings.providers.page.actions.copy')}
              </Button>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className={cn('space-y-4', className)}>
      {methods.map((method) => {
        const isActive = activeMethodID === method.id;

        return (
          <div key={method.id} className="space-y-3">
            {showStartButton ? (
              <div className="flex items-center justify-between gap-2">
                {showMethodLabels ? <div className="typography-ui-label text-foreground">{method.label}</div> : null}
                <Button
                  variant="outline"
                  size="xs"
                  className="!font-normal shrink-0"
                  onClick={() => beginConnect(method)}
                  disabled={busy}
                >
                  {connectLabel ?? t('settings.providers.page.actions.connect')}
                </Button>
              </div>
            ) : null}

            {isActive && flow.phase === 'prompting' && (
              <div className="space-y-3">
                <ProviderFormFields
                  fields={flow.fields}
                  values={fieldValues}
                  onChange={(key, value) => setFieldValues((prev) => ({ ...prev, [key]: value }))}
                />
                {flow.error && (
                  <p className="typography-meta text-[var(--status-error)]">{flow.error}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button size="xs" className="!font-normal" onClick={() => submitFields(method)}>
                    {t('settings.providers.page.actions.continue')}
                  </Button>
                  <Button variant="ghost" size="xs" className="!font-normal" onClick={cancel}>
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {isActive && flow.phase === 'connecting' && (
              <p className="typography-meta text-muted-foreground flex items-center gap-2">
                <Spinner className="h-3.5 w-3.5" />
                {method.type === 'external'
                  ? t('settings.providers.page.auth.external.connecting')
                  : t('settings.providers.page.auth.oauth.starting')}
              </p>
            )}

            {isActive && flow.phase === 'waiting' && (
              <div className="space-y-3">
                {renderAttemptDetails(flow.attempt)}
                <div className="flex items-center justify-between gap-2">
                  <p className="typography-meta text-muted-foreground flex items-center gap-2">
                    <Spinner className="h-3.5 w-3.5" />
                    {t('settings.providers.page.auth.oauth.waiting')}
                  </p>
                  <Button variant="ghost" size="xs" className="!font-normal shrink-0" onClick={cancel}>
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
                <p className="typography-meta text-muted-foreground">
                  {t('settings.providers.page.auth.oauth.waitingHint')}
                </p>
              </div>
            )}

            {isActive && flow.phase === 'awaitingCode' && (
              <div className="space-y-3">
                {renderAttemptDetails(flow.attempt)}
                <p className="typography-meta text-muted-foreground">
                  {t('settings.providers.page.auth.oauth.codeHint')}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={codeInput}
                    onChange={(event) => setCodeInput(event.target.value)}
                    placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                    className="font-mono text-xs"
                    disabled={flow.submitting}
                  />
                  <Button
                    size="xs"
                    className="!font-normal shrink-0"
                    onClick={() => void submitCode()}
                    disabled={flow.submitting || codeInput.trim().length === 0}
                  >
                    {flow.submitting
                      ? t('settings.providers.page.actions.saving')
                      : t('settings.providers.page.actions.complete')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="!font-normal shrink-0"
                    onClick={cancel}
                    disabled={flow.submitting}
                  >
                    {t('settings.providers.page.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {isActive && flow.phase === 'failed' && (
              <div className="space-y-2">
                <p className="typography-meta text-[var(--status-error)]">{flow.message}</p>
                {showStartButton ? (
                  <Button
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    onClick={() => beginConnect(method)}
                  >
                    {t('settings.providers.page.actions.tryAgain')}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
