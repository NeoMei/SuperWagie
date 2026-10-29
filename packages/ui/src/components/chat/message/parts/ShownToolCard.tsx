import React from 'react';

import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { isQuestionTool, proposedWorkflowRunId } from '@/lib/opencode/tools';
import { useUIStore } from '@/stores/useUIStore';
import { WorkflowRunCard } from '@/components/chat/workflows/WorkflowRunCard';
import { ShownPage } from './HtmlRenderFrame';
import ToolPart from './ToolPart';

/**
 * What a call the chat shows in place (`isShownInPlace`) draws instead of its
 * row: a question, the run a `workflow.run` call proposed, or the page it showed.
 */
export function ShownToolCard({ part }: { part: ToolPartData }) {
  const runId = React.useMemo(() => proposedWorkflowRunId(part.tool, part.state), [part.tool, part.state]);
  if (isQuestionTool(part.tool)) return <QuestionToolCard key={part.id} part={part} />;
  if (runId) return <WorkflowRunCard sessionId={part.sessionID} runId={runId} />;
  return <ShownPage part={part} />;
}

/** The transcript keeps the question and answer; FormDock owns the live reply. */
function QuestionToolCard({ part }: { part: ToolPartData }) {
  const [expanded, setExpanded] = React.useState(true);
  const isMobile = useUIStore((state) => state.isMobile);
  return <ToolPart part={part} isExpanded={expanded} onToggle={() => setExpanded((value) => !value)} isMobile={isMobile} />;
}
