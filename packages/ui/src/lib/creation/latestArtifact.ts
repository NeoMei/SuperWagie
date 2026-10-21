import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { sessionArtifactsInText } from '@/lib/guests/sessionArtifacts';

/**
 * The final file path the assistant named, preferring its newest answer. This
 * is the same source the workbench uses; a 作品 shortcut should not land on the
 * project folder when the conversation already names the file.
 */
export const latestArtifactPath = (sessionId: string, directory: string): string | null => {
  const messages = getSyncMessages(sessionId, directory);
  let scanned = 0;
  for (let index = messages.length - 1; index >= 0 && scanned < 5; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    scanned += 1;
    const found = new Map<string, string>();
    for (const part of getSyncParts(message.id, directory)) {
      const texts: string[] = [];
      if (part.type === 'text') texts.push(part.text.slice(0, 20_000));
      else if (part.type === 'file') texts.push(part.filename ?? '', part.url);
      for (const text of texts) {
        for (const artifact of sessionArtifactsInText(text, directory)) found.set(artifact.path, artifact.path);
      }
    }
    if (found.size > 0) return [...found.values()][0] ?? null;
  }
  return null;
};
