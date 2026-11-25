import React from 'react';

import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RequestedSecret, RequestedSecretRun } from '@/lib/opencode/tools';
import { answerSecretRequest, forgetSavedSecret, readSecretRunFields } from '@/lib/secretRequestAnswer';
import type { SecretRunAnswer, SecretRunFields } from '@/lib/secretRequestAnswer';
import { useIsPageWaiting } from '@/sync/global-blocking-requests';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDirectory } from '@/sync/sync-context';

import ToolPartRow from './ToolPart';

function SecretInput({ value, onChange, placeholder, ariaLabel, disabled }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    ariaLabel: string;
    disabled: boolean;
}) {
    const { t } = useI18n();
    const [revealed, setRevealed] = React.useState(false);
    return (
        <div className="relative min-w-0 flex-1">
            <Input
                type={revealed ? 'text' : 'password'}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                aria-label={ariaLabel}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                disabled={disabled}
                className="w-full pe-9"
            />
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute inset-e-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={t(revealed ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                aria-pressed={revealed}
                title={t(revealed ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                disabled={disabled}
                onClick={() => setRevealed((current) => !current)}
            >
                <Icon name={revealed ? 'eye-off' : 'eye'} className="size-4" />
            </Button>
        </div>
    );
}

function useWaitingIntoView(waiting: boolean) {
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
    }, [waiting]);
    return blockRef;
}

function SecretCallRow({ part }: { part: ToolPart }) {
    const isMobile = useUIStore((state) => state.isMobile);
    const [expanded, setExpanded] = React.useState(false);
    const toggle = React.useCallback(() => setExpanded((current) => !current), []);
    return <ToolPartRow part={part} isExpanded={expanded} onToggle={toggle} isMobile={isMobile} animateTailText={false} />;
}

export function SecretRequestCard({ part, request }: { part: ToolPart; request: RequestedSecret }) {
    const { t } = useI18n();
    const directory = useSessionDirectory(part.sessionID);
    const [value, setValue] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [sent, setSent] = React.useState(false);

    const send = React.useCallback(async (answer: { value: string } | { declined: true }) => {
        setBusy(true);
        try {
            await answerSecretRequest({ sessionId: part.sessionID, callId: part.callID, ...answer }, directory);
            setValue('');
            setSent(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.secretRequest.saveFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    }, [directory, part.callID, part.sessionID, t]);

    const blockRef = useWaitingIntoView(!sent);
    if (sent) return <SecretCallRow part={part} />;

    return (
        <div ref={blockRef} className="oc-tile my-2 rounded-xl p-4" data-secret-request-status="waiting" data-waiting-page={part.id}>
            <div className="typography-ui-label font-semibold text-foreground">{request.label}</div>
            <p className="mt-1 whitespace-pre-wrap break-words typography-markdown text-muted-foreground">{request.reason}</p>
            <form
                className="mt-3 flex items-center gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (value.trim() && !busy) void send({ value });
                }}
            >
                <SecretInput
                    value={value}
                    onChange={setValue}
                    placeholder={request.placeholder ?? t('chat.secretRequest.placeholder')}
                    ariaLabel={t('chat.secretRequest.inputLabel')}
                    disabled={busy}
                />
                <Button type="submit" disabled={busy || !value.trim()}>{t('chat.secretRequest.save')}</Button>
            </form>
            <div className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="shield-check" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{t('chat.secretRequest.privacy')}</span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send({ declined: true })}>
                    {t('chat.secretRequest.decline')}
                </Button>
            </div>
        </div>
    );
}

type Retention = 'once' | 'session' | 'project' | 'global';

const retentionLabels = {
    once: 'chat.secretRun.keepOnce',
    session: 'chat.secretRun.remember',
    project: 'chat.secretRun.saveForProject',
    global: 'chat.secretRun.saveGlobally',
} as const;
const SECRET_FIELDS_RETRY_MS = 2_000;

export function SecretRunCard({ part, run }: { part: ToolPart; run: RequestedSecretRun }) {
    const directory = useSessionDirectory(part.sessionID);
    return <SecretRunForm key={JSON.stringify([part.sessionID, part.callID, directory])} part={part} run={run} directory={directory} />;
}

function SecretRunForm({ part, run, directory }: { part: ToolPart; run: RequestedSecretRun; directory?: string }) {
    const { t } = useI18n();
    const [values, setValues] = React.useState(new Map<string, string>());
    const [retention, setRetention] = React.useState(new Map<string, Retention>());
    const [busy, setBusy] = React.useState(false);
    const [sent, setSent] = React.useState(false);
    const [card, setCard] = React.useState<SecretRunFields | null>(null);
    const waiting = useIsPageWaiting(part.sessionID, part.callID) && !sent;

    React.useEffect(() => {
        if (!waiting) return;
        let current = true;
        let retry: ReturnType<typeof setTimeout> | undefined;
        const read = () => {
            void readSecretRunFields({ sessionId: part.sessionID, callId: part.callID }, directory)
                .catch(() => null)
                .then((fields) => {
                    if (!current) return;
                    if (fields) setCard(fields);
                    else retry = setTimeout(read, SECRET_FIELDS_RETRY_MS);
                });
        };
        read();
        return () => {
            current = false;
            clearTimeout(retry);
        };
    }, [directory, part.callID, part.sessionID, waiting]);

    const asking = waiting && card !== null && card.fields.length > 0;
    const blockRef = useWaitingIntoView(asking);
    const identity = { sessionId: part.sessionID, callId: part.callID };

    const send = async (answer: SecretRunAnswer | { declined: true }) => {
        setBusy(true);
        try {
            await answerSecretRequest({ ...identity, ...answer }, directory);
            setValues(new Map());
            setSent(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.secretRun.sendFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    };

    const forget = async (env: string, consent: string) => {
        setBusy(true);
        try {
            setCard(await forgetSavedSecret({ ...identity, forgetSaved: env, consent }, directory));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.secretRun.forgetFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    };

    if (!asking || !card) {
        if (waiting) return null;
        return <SecretCallRow part={part} />;
    }

    const consent = card.consent;
    const asked = run.fields.filter((field) => card.fields.includes(field.env));
    const savedScope = (env: string) => consent && card.saved && Object.hasOwn(card.saved, env) ? card.saved[env] : undefined;
    const typed = asked.filter((field) => !savedScope(field.env));
    const complete = asked.length === card.fields.length && typed.every((field) => values.get(field.env)?.trim());
    const picks = (scope: Retention) => typed.filter((field) => retention.get(field.env) === scope).map((field) => field.env);
    const reusedLabels = run.fields.filter((field) => card.reused.includes(field.env)).map((field) => field.label);
    const options: Retention[] = card.projectPath ? ['once', 'session', 'project', 'global'] : ['once', 'session', 'global'];
    const setKeep = (env: string, next: Retention) => setRetention((current) => new Map(current).set(env, next));
    const save = picks('project');
    const saveGlobally = picks('global');
    return (
        <div ref={blockRef} className="oc-tile my-2 rounded-xl p-4" data-secret-request-status="waiting" data-waiting-page={part.id}>
            <div className="typography-ui-label font-semibold text-foreground">{t('chat.secretRun.title', { program: run.program })}</div>
            <p className="mt-1 whitespace-pre-wrap break-words typography-markdown text-muted-foreground">{run.reason}</p>
            {card.projectPath && (
                <p className="mt-1 break-all typography-meta text-muted-foreground" dir="auto">
                    {t('chat.secretRun.projectPath', { path: card.projectPath })}
                </p>
            )}
            <pre
                className="typography-code oc-tile-inset mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg px-2 py-1.5 font-mono text-foreground"
                aria-label={t('chat.secretRun.commandLabel')}
            >
                {run.command}
            </pre>
            <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!complete || busy) return;
                    void send({
                        values: Object.fromEntries(typed.map((field) => [field.env, values.get(field.env) ?? ''])),
                        remember: picks('session'),
                        ...(consent && { consent, save, saveGlobally }),
                    });
                }}
            >
                {asked.map((field) => {
                    const scope = savedScope(field.env);
                    const keep = retention.get(field.env) ?? 'once';
                    return (
                        <div key={field.env} className="flex flex-col gap-1.5">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="min-w-0 typography-ui-label text-foreground">{field.label}</span>
                                <bdi className="shrink-0 font-mono typography-meta text-muted-foreground">{field.env}</bdi>
                            </div>
                            {scope && consent ? (
                                <div className="oc-tile-inset flex items-center justify-between gap-2 rounded-lg ps-2">
                                    <span className="typography-meta text-muted-foreground">
                                        {t(scope === 'project' ? 'chat.secretRun.savedForProject' : 'chat.secretRun.savedGlobally')}
                                    </span>
                                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void forget(field.env, consent)}
                                        aria-label={t('chat.secretRun.forgetSavedLabel', { label: field.label })}>
                                        {t('chat.secretRun.forgetSaved')}
                                    </Button>
                                </div>
                            ) : (
                                <>
                                    <SecretInput
                                        value={values.get(field.env) ?? ''}
                                        onChange={(value) => setValues((current) => new Map(current).set(field.env, value))}
                                        placeholder={field.placeholder ?? t('chat.secretRequest.placeholder')}
                                        ariaLabel={field.label}
                                        disabled={busy}
                                    />
                                    {consent ? (
                                        <Select<Retention> value={keep} onValueChange={(next) => setKeep(field.env, next)} disabled={busy}>
                                            <SelectTrigger aria-label={t('chat.secretRun.retentionLabel', { label: field.label })}>
                                                <SelectValue>{t(retentionLabels[keep])}</SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {options.map((option) => <SelectItem key={option} value={option}>{t(retentionLabels[option])}</SelectItem>)}
                                            </SelectContent>
                                        </Select>
                                    ) : (
                                        <label className="flex w-fit cursor-pointer items-center gap-1.5 typography-meta text-muted-foreground">
                                            <Checkbox
                                                ariaLabel={t('chat.secretRun.remember')}
                                                checked={keep === 'session'}
                                                onChange={(checked) => setKeep(field.env, checked ? 'session' : 'once')}
                                                disabled={busy}
                                            />
                                            <span>{t('chat.secretRun.remember')}</span>
                                        </label>
                                    )}
                                </>
                            )}
                        </div>
                    );
                })}
                {reusedLabels.length > 0 && (
                    <div className="typography-meta text-muted-foreground">{t('chat.secretRun.reused', { labels: reusedLabels.join(', ') })}</div>
                )}
                {(save.length > 0 || saveGlobally.length > 0) && (
                    <p className="typography-meta text-muted-foreground">{t('chat.secretRun.storedWarning')}</p>
                )}
                <div className="flex items-center gap-1.5 typography-meta text-muted-foreground">
                    <Icon name="shield-check" className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">{t('chat.secretRun.privacy')}</span>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send({ declined: true })}>
                        {t('chat.secretRequest.decline')}
                    </Button>
                    <Button type="submit" size="sm" disabled={busy || !complete}>{t('chat.secretRun.submit')}</Button>
                </div>
            </form>
        </div>
    );
}
