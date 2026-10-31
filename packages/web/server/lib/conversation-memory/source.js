import { isSessionNotFoundError } from '@opencode/client';
import { z } from 'zod';
import { validateConversationAnchor } from './reader.js';

const sourceSchema = z.object({
  id: z.string().min(1),
  location: z.object({ directory: z.string().min(1) }),
  revert: z.object({ messageID: z.string().min(1) }).nullish(),
});

/** Only the SDK's session-not-found error establishes deletion. */
export const readConversationSource = async ({ client, sessionId, checkpoint, signal }) => {
  try {
    const deadline = AbortSignal.timeout(1000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const source = sourceSchema.parse(await client.session.get(
      { sessionID: sessionId },
      { signal: requestSignal },
    ));
    if (source.id !== sessionId) throw Object.assign(new Error('Source session does not match'), { code: 'source_scope_mismatch' });
    const current = { directory: source.location.directory, revertId: source.revert?.messageID ?? null };
    if (checkpoint) current.anchorMatches = await validateConversationAnchor({ client, sessionId, checkpoint, signal: requestSignal });
    return current;
  } catch (error) {
    if (isSessionNotFoundError(error)) return null;
    throw error;
  }
};
