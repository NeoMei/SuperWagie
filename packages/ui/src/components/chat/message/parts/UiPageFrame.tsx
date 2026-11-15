import React from 'react';
import { toast } from '@/components/ui';
import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import { answerRenderedPage } from '@/lib/renderPageAnswer';
import { pageAnswerSummary, uiBlockAnswerData, type UiBlockAnswer } from '../../uiBlocks/answer';
import type { UiBlockHost } from '../../uiBlocks/UiBlock';
import { useUiBlockComponent } from '../../uiBlocks/useUiBlockComponent';
import { PageAskStatus } from './PageAskStatus';

/** Native pages use the existing answer contract; unsupported programs retain readable errors and source. */
export function UiPageFrame({ part, source, ask }: { part: ToolPart; source: string; ask: RenderedPageAsk }) {
    const { t } = useI18n();
    const UiBlock = useUiBlockComponent();
    const [sentSummary, setSentSummary] = React.useState<string | null>(null);
    const waiting = ask.kind === 'waiting' && sentSummary === null;
    const submit = React.useCallback(async (answer: UiBlockAnswer) => {
        const summary = pageAnswerSummary(answer.summary);
        try {
            await answerRenderedPage({ sessionId: part.sessionID, callId: part.callID, summary, data: answer.data });
            setSentSummary(summary);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.htmlRender.answerFailed'), { description: message });
            throw error;
        }
    }, [part.callID, part.sessionID, t]);
    const host = React.useMemo<UiBlockHost>(() => {
        const answered = ask.kind === 'answered' ? uiBlockAnswerData.safeParse(ask.data) : null;
        return { kind: 'page', submit: waiting ? submit : null, answered: answered?.success ? answered.data : null };
    }, [ask, waiting, submit]);
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
    }, [waiting]);
    return (
        <div ref={blockRef} className="my-2" data-ui-render-part={part.id} data-ui-render-message={part.messageID}
            data-waiting-page={waiting ? part.id : undefined}>
            {UiBlock ? <UiBlock source={source} complete host={host} />
                : <pre dir="ltr" data-chat-quote-pending="true"><code>{source}</code></pre>}
            <PageAskStatus ask={ask} answeredSummary={ask.kind === 'answered' ? ask.summary : sentSummary ?? undefined} />
        </div>
    );
}
