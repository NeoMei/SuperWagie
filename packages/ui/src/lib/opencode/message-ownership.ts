type AncestorMessageSource<T> = {
  readMessage: (sessionID: string) => Promise<T>
  readParentID: (sessionID: string) => Promise<string | undefined>
  isNotFound: (error: Error) => boolean
  /** False once the runtime the lookup started on is no longer current. */
  isCurrent: () => boolean
}

const MAX_SESSION_READS = 32

export async function readMessageThroughAncestors<T>(sessionID: string, source: AncestorMessageSource<T>): Promise<T> {
  let notFound: Error | undefined
  const visited = new Set<string>()
  let current: string | undefined = sessionID
  while (current !== undefined && !visited.has(current) && visited.size < MAX_SESSION_READS) {
    visited.add(current)
    try {
      const message = await source.readMessage(current)
      if (!source.isCurrent()) throw notFound ?? new Error("Runtime changed during tool-content lookup")
      return message
    } catch (error) {
      if (!(error instanceof Error) || !source.isNotFound(error)) throw error
      notFound ??= error
    }
    if (!source.isCurrent()) break
    try {
      current = await source.readParentID(current)
    } catch (error) {
      if (!(error instanceof Error) || !source.isNotFound(error)) throw error
      break
    }
    if (!source.isCurrent()) break
  }
  throw notFound
}
