import { z } from 'zod';

const sessionRecord = z.object({}).passthrough();
const messagePage = z.object({ data: z.array(z.unknown()), cursor: z.object({}).passthrough().nullish() }).passthrough();
const messageRecord = z.object({ type: z.string() }).passthrough();
const promptID = z.string().regex(/^msg_[A-Za-z0-9_-]{1,180}$/);
const cursorToken = z.string();

// OpenCode returns newest records first only when the initial request asks for
// descending order. The continuation cursor already contains that ordering.
// Never walk past a turn-ending idle record or an unreadable page: neither can
// prove which prompt is currently authorized to incur charges.
export async function readPlatformExecution(client, sessionID) {
  const sessionResult = sessionRecord.safeParse(await client.session.get({ sessionID }));
  if (!sessionResult.success) throw new Error('platform_execution_unavailable');
  const session = sessionResult.data;
  const result = { model: session.model, parentID: session.parentID, idle: session.time?.idle, promptID: undefined };
  const seen = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const pageResult = messagePage.safeParse(await client.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: 'desc' }) }));
    if (!pageResult.success) throw new Error('platform_execution_unavailable');
    const page = pageResult.data;
    for (const rawMessage of page.data) {
      const messageResult = messageRecord.safeParse(rawMessage);
      if (!messageResult.success) throw new Error('platform_execution_unavailable');
      const message = messageResult.data;
      if (message.type === 'idle') return result;
      if (message.type === 'user') {
        const parsed = promptID.safeParse(message.id);
        if (!parsed.success) throw new Error('platform_execution_unavailable');
        result.promptID = parsed.data;
        return result;
      }
    }
    const next = page.cursor?.next;
    if (next == null || next === '') return result;
    const parsed = cursorToken.safeParse(next);
    if (!parsed.success || seen.has(parsed.data) || page.data.length === 0) throw new Error('platform_execution_unavailable');
    seen.add(parsed.data);
    cursor = parsed.data;
  }
  return result;
}
