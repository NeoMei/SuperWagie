// OpenCode returns newest records first only when the initial request asks for
// descending order. The continuation cursor already contains that ordering.
// Never walk past a turn-ending idle record or an unreadable page: neither can
// prove which prompt is currently authorized to incur charges.
export async function readPlatformExecution(client, sessionID) {
  const session = await client.session.get({ sessionID });
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('platform_execution_unavailable');
  const result = { model: session.model, parentID: session.parentID, idle: session.time?.idle, promptID: undefined };
  const seen = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await client.message.list({ sessionID, limit: 100, ...(cursor ? { cursor } : { order: 'desc' }) });
    if (!page || !Array.isArray(page.data) || (page.cursor != null && (typeof page.cursor !== 'object' || Array.isArray(page.cursor)))) throw new Error('platform_execution_unavailable');
    for (const message of page.data) {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('platform_execution_unavailable');
      if (message.type === 'idle') return result;
      if (message.type === 'user') {
        if (typeof message.id !== 'string' || !/^msg_[A-Za-z0-9_-]{1,180}$/.test(message.id)) throw new Error('platform_execution_unavailable');
        result.promptID = message.id;
        return result;
      }
    }
    const next = page.cursor?.next;
    if (next == null || next === '') return result;
    if (typeof next !== 'string' || seen.has(next) || page.data.length === 0) throw new Error('platform_execution_unavailable');
    seen.add(next);
    cursor = next;
  }
  return result;
}
