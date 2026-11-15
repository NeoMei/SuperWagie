import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { ascendingId } from '@/lib/opencode/ids';
import type { Message } from '@/lib/opencode/model';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { commitStagedRevert } from '@/sync/session-actions';
import { useSessionMessagesSelector } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { UI_BLOCK_ANSWER_METADATA_KEY, uiBlockAnswerRecord, type UiBlockReplyAnswerData } from './answer';

type ReplyBlock = { sessionId: string; directory: string; messageId: string; block: string };

// One input id per block for this client's lifetime: a retry after a lost
// response reuses it, and OpenCode refuses the repeat.
const inputIds = new Map<string, string>();
const inputIdFor = (target: ReplyBlock, runtimeKey: string): string => {
  const key = `${runtimeKey}\u0000${target.directory}\u0000${target.sessionId}\u0000${target.messageId}\u0000${target.block}`;
  const known = inputIds.get(key);
  if (known) return known;
  const id = ascendingId('msg');
  inputIds.set(key, id);
  return id;
};

/**
 * Hands the agent the choices made in a block of its reply. They travel as
 * synthetic input that starts the agent's next turn, so the chat shows no
 * user message for them; the input's metadata records the answer for the block.
 */
export async function sendUiBlockReplyAnswer(target: ReplyBlock, answer: UiBlockReplyAnswerData, text: string): Promise<void> {
  const runtimeKey = getRuntimeKey();
  const isCurrentRuntime = captureRuntimeInstance();
  const stores = getSyncChildStores();
  const owner = stores.getChild(target.directory);
  const assertCurrent = () => {
    if (!isCurrentRuntime() || getSyncChildStores() !== stores || !owner || stores.getChild(target.directory) !== owner) {
      throw new Error('UI block answer was cancelled because its runtime or session store changed.');
    }
  };
  assertCurrent();
  await commitStagedRevert(target.sessionId, target.directory);
  assertCurrent();
  await opencodeClient.resumeWithSyntheticInput({
    runtimeKey,
    id: inputIdFor(target, runtimeKey),
    sessionId: target.sessionId,
    directory: target.directory,
    text,
    metadata: { [UI_BLOCK_ANSWER_METADATA_KEY]: { messageId: target.messageId, block: target.block, answer } },
  });
  assertCurrent();
}

const findAnswer = (messages: Message[], target: ReplyBlock): UiBlockReplyAnswerData | null => {
  for (const message of messages) {
    if (message.role !== 'synthetic') continue;
    const record = uiBlockAnswerRecord.safeParse(message.metadata?.[UI_BLOCK_ANSWER_METADATA_KEY]);
    if (record.success && record.data.messageId === target.messageId && record.data.block === target.block) return record.data.answer;
  }
  return null;
};

const sameAnswer = (left: UiBlockReplyAnswerData | null, right: UiBlockReplyAnswerData | null) => (
  left === right || (left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right))
);

/** The answer this block already gave, read back from the session; null until it has one. */
export function useUiBlockReplyAnswer(target: ReplyBlock | null): UiBlockReplyAnswerData | null {
  const select = React.useCallback(
    (messages: Message[]) => (target ? findAnswer(messages, target) : null),
    [target],
  );
  return useSessionMessagesSelector(target?.sessionId ?? '', target?.directory, select, sameAnswer);
}
