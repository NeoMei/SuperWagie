import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { isSettledAsk, type ShownPart } from '../../lib/turns/liveActivity';
import AssistantTextPart from './AssistantTextPart';
import { PageAskStatus } from './PageAskStatus';
import { proposedWorkflowRunId, renderedPage, requestedSecret, requestedSecretRun } from '@/lib/opencode/tools';
import { WorkflowRunCard } from '@/components/chat/workflows/WorkflowRunCard';
import type { ToolPopupContent } from '../types';
import { ShownPage } from './HtmlRenderFrame';
import { useUIStore } from '@/stores/useUIStore';
import ToolPartRow from './ToolPart';
import { SecretRequestCard, SecretRunCard } from './SecretRequestCard';

/** Draw supported cards in place, keeping other call results as ordinary rows. */
export function ShownToolCard({ part, onShowPopup }: { part: ToolPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  const runId = React.useMemo(() => proposedWorkflowRunId(part.tool, part.state), [part.tool, part.state]);
  const page = React.useMemo(() => renderedPage(part.tool, part.state), [part.tool, part.state]);
  const secret = React.useMemo(() => requestedSecret(part.tool, part.state), [part.tool, part.state]);
  const secretRun = React.useMemo(() => requestedSecretRun(part.tool, part.state), [part.tool, part.state]);
  if (runId) return <WorkflowRunCard sessionId={part.sessionID} runId={runId} />;
  if (page) return <ShownPage part={part} />;
  if (secret) return <SecretRequestCard part={part} request={secret} />;
  if (secretRun) return <SecretRunCard part={part} run={secretRun} />;
  return <OrdinaryToolCard part={part} onShowPopup={onShowPopup} />;
}

/** Unsupported card capabilities retain the complete call's normal disclosure. */
function OrdinaryToolCard({ part, onShowPopup }: { part: ToolPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  const isMobile = useUIStore((state) => state.isMobile);
  const [expanded, setExpanded] = React.useState(false);
  return <ToolPartRow part={part} isExpanded={expanded} onToggle={() => setExpanded((current) => !current)}
    isMobile={isMobile} onShowPopup={onShowPopup} />;
}

/** A settled form a collapsed Activity keeps in view: one line, no form. */
function SettledAskLine({ part }: { part: ToolPart }) {
  const page = React.useMemo(() => renderedPage(part.tool, part.state), [part.tool, part.state]);
  if (!page) return null;
  return (
    <div className="my-2">
      <PageAskStatus ask={page.ask} answeredSummary={page.ask.kind === 'answered' ? page.ask.summary : undefined} />
    </div>
  );
}

/**
 * A part a collapsed Activity keeps in view (`getShownPages`): a call drawn in
 * place, the line of a settled form, or the text with a UI block the agent
 * wrote before a later step.
 */
export function ShownPartCard({ part, onShowPopup }: { part: ShownPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  if (part.type === 'tool') {
    if (isSettledAsk(part)) return <SettledAskLine part={part} />;
    return <ShownToolCard part={part} onShowPopup={onShowPopup} />;
  }
  return (
    <AssistantTextPart
      part={part}
      sessionId={part.sessionID}
      messageId={part.messageID}
      streamPhase={part.time?.end === undefined ? 'streaming' : 'completed'}
      onShowPopup={onShowPopup}
    />
  );
}
