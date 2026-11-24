import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { Message, Session } from '@/lib/opencode/model';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { leadDigest, leadParentId, leadReplyReceipts, type LeadDigest } from '@/lib/sessionLead';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { readLeadBrief, sendLeadReply, useLeadStrings } from '@/sync/session-lead';
import { useSessionMessagesSelector } from '@/sync/sync-context';

const sameReceipts = (left: ReadonlySet<string>, right: ReadonlySet<string>) => (
  left.size === right.size && [...left].every((key) => right.has(key))
);

type BriefState = { type: 'loading' } | { type: 'error' } | { type: 'loaded'; text: string | null };

function LeadBrief({ session, revision }: { session: Session; revision?: number }) {
  const labels = useLeadStrings();
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [brief, setBrief] = React.useState<BriefState | null>(null);
  const { id, directory } = session;
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const current = captureRuntimeInstance();
    setBrief({ type: 'loading' });
    void readLeadBrief(id, directory, controller.signal).then(
      (text) => { if (current() && !controller.signal.aborted) setBrief({ type: 'loaded', text }); },
      () => { if (current() && !controller.signal.aborted) setBrief({ type: 'error' }); },
    );
    return () => controller.abort();
  }, [open, id, directory, revision]);

  return (
    <>
      <Button variant="ghost" size="xs" aria-pressed={open} onClick={() => setOpen((value) => !value)}>{labels.brief}</Button>
      {open ? (
        <div className="oc-tile-inset max-h-52 basis-full overflow-auto whitespace-pre-wrap break-words p-2 typography-meta" dir="auto">
          {brief?.type === 'loaded' ? brief.text || labels.emptyBrief
            : brief?.type === 'error' ? labels.briefFailed : t('common.loading')}
        </div>
      ) : null}
    </>
  );
}

function DigestFeedback({ session, digest, canReply }: { session: Session; digest: LeadDigest; canReply: boolean }) {
  const text = useLeadStrings();
  const formId = React.useId();
  const sendingRef = React.useRef(false);
  const [sending, setSending] = React.useState(false);
  const [answers, setAnswers] = React.useState(new Map<string, string>());
  const [decisions, setDecisions] = React.useState(new Map<string, boolean>());
  const [sent, setSent] = React.useState<ReadonlySet<string>>(() => new Set());
  const receipts = useSessionMessagesSelector(
    session.id, session.directory,
    React.useCallback((messages: Message[]) => leadReplyReceipts(messages, digest.updatedAt), [digest.updatedAt]),
    sameReceipts,
  );
  const disabled = !canReply || sending;
  const needsYou = digest.needsYou.filter(({ question }) => !sent.has(`question:${question}`) && !receipts.has(`question:${question}`));
  const suggestions = digest.suggestions.filter((item) => !sent.has(`suggestion:${item}`) && !receipts.has(`suggestion:${item}`));
  const replies = needsYou.flatMap(({ question }) => {
    const answer = answers.get(question)?.trim();
    return answer ? [{ question, answer }] : [];
  });
  const picks = suggestions.flatMap((item) => {
    const accepted = decisions.get(item);
    return accepted === undefined ? [] : [{ item, accepted }];
  });
  if (needsYou.length + suggestions.length === 0) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled || sendingRef.current) return;
    if (!replies.length && !picks.length) return;
    const current = captureRuntimeInstance();
    sendingRef.current = true;
    setSending(true);
    try {
      await sendLeadReply(session, digest.updatedAt, { answers: replies, suggestions: picks });
      if (current()) setSent((previous) => new Set([
        ...previous,
        ...replies.map(({ question }) => `question:${question}`),
        ...picks.map(({ item }) => `suggestion:${item}`),
      ]));
    } catch (error) {
      if (current()) toast.error(text['chat.leadDigest.sendFailed'], { description: error instanceof Error ? error.message : undefined });
    } finally {
      sendingRef.current = false;
      if (current()) setSending(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      {needsYou.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label={text['chat.leadDigest.needsYou']}>
          <h3 className="font-medium text-muted-foreground">{text['chat.leadDigest.needsYou']}</h3>
          {needsYou.map((item, index) => (
            <div className="flex flex-col gap-1" key={item.question}>
              <label dir="auto" htmlFor={`${formId}-${index}`}>{item.question}</label>
              {item.options.length ? (
                <div className="flex flex-wrap gap-1">
                  {item.options.map((option) => (
                    <Button key={option} size="xs" variant="chip" type="button" disabled={disabled}
                      aria-pressed={answers.get(item.question) === option}
                      onClick={() => setAnswers((current) => new Map(current).set(item.question, option))}>
                      {option}
                      {item.recommended === option ? <span className="opacity-70">{text['chat.leadDigest.recommended']}</span> : null}
                    </Button>
                  ))}
                </div>
              ) : null}
              <Input id={`${formId}-${index}`} inputSize="compact" maxLength={2_000} disabled={disabled} dir="auto"
                placeholder={text['chat.leadDigest.ownAnswer']} value={answers.get(item.question) ?? ''}
                onChange={(event) => { const value = event.target.value; setAnswers((current) => new Map(current).set(item.question, value)); }} />
            </div>
          ))}
        </section>
      ) : null}
      {suggestions.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium text-muted-foreground">{text['chat.leadDigest.suggestions']}</h3>
          {suggestions.map((item) => (
            <div key={item} className="flex flex-wrap items-center justify-between gap-1">
              <span dir="auto">{item}</span>
              <div className="flex gap-1" role="group" aria-label={item}>
                {([true, false] as const).map((accepted) => (
                  <Button key={String(accepted)} size="xs" variant="chip" type="button" disabled={disabled}
                    aria-pressed={decisions.get(item) === accepted}
                    onClick={() => setDecisions((current) => new Map(current).set(item, accepted))}>
                    {text[accepted ? 'chat.leadDigest.accept' : 'chat.leadDigest.decline']}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </section>
      ) : null}
      <Button className="self-end" size="xs" type="submit"
        disabled={disabled || (!picks.length && !replies.length)}>
        {text['chat.leadDigest.send']}
      </Button>
    </form>
  );
}

function AssociatedWork({ session }: { session: Session }) {
  const text = useLeadStrings();
  const scoped = useGlobalSessionsStore((state) => state.sessionsByDirectory.get(session.directory));
  const associated = scoped?.filter((item) => !item.time.archived && leadParentId(item) === session.id) ?? [];
  if (!associated.length) return null;
  return (
    <section className="flex flex-col items-start gap-1">
      <h3 className="font-medium text-muted-foreground">{text.associatedWork}</h3>
      {associated.map((item) => (
        <Button key={item.id} size="xs" variant="ghost" onClick={() => useSessionUIStore.getState().setCurrentSession(item.id, item.directory)}>
          <span className="truncate" dir="auto">{item.title}</span>
        </Button>
      ))}
    </section>
  );
}

export function LeadDigestRow({ session, canReply, showBrief }: { session: Session; canReply: boolean; showBrief: boolean }) {
  const text = useLeadStrings();
  const digest = leadDigest(session);
  return (
    <div className="chat-input-column my-2 shrink-0">
      <details className="oc-tile max-h-[40vh] overflow-y-auto p-2 typography-meta">
        <summary className="cursor-pointer font-medium">
          <Icon name="team" className="mx-1 inline size-3.5 align-text-bottom" />
          {text['sessions.sidebar.session.leadMark']}
          {digest?.needsYou.length ? <span className="ms-2 text-status-warning">{text['chat.leadDigest.needsYou']}</span> : null}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {showBrief ? <div className="flex flex-wrap items-center gap-1"><LeadBrief session={session} revision={digest?.updatedAt} /></div> : null}
          <AssociatedWork session={session} />
          {digest ? (
            <>
              {([['now', 'chat.leadDigest.now'], ['news', 'chat.leadDigest.news']] as const).map(([section, title]) => (
                digest[section].length > 0 ? (
                  <section key={section}>
                    <h3 className="font-medium text-muted-foreground">{text[title]}</h3>
                    <ul className="list-disc ps-4">
                      {digest[section].map((item, index) => <li dir="auto" key={index}>{item}</li>)}
                    </ul>
                  </section>
                ) : null
              ))}
              <DigestFeedback key={digest.updatedAt} session={session} digest={digest} canReply={canReply} />
            </>
          ) : null}
        </div>
      </details>
    </div>
  );
}
