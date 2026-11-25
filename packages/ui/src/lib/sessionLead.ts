import { z } from 'zod';
import type { Message, Session } from '@/lib/opencode/model';

const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).catch([]),
  recommended: z.string().optional(),
});
const digestSchema = z.object({
  updatedAt: z.number().finite(),
  needsYou: z.array(z.union([z.string().transform((question): z.infer<typeof questionSchema> => ({ question, options: [] })), questionSchema])).catch([]),
  now: z.array(z.string()).catch([]),
  news: z.array(z.string()).catch([]),
  suggestions: z.array(z.string()).catch([]),
});
const markerSchema = z.object({ at: z.number().finite(), digest: digestSchema.optional().catch(undefined) });
const leadMetadataSchema = z.object({ openchamber: z.object({ lead: markerSchema }) });
const associationSchema = z.object({ openchamber: z.object({ leadParentID: z.string() }) });

export const leadParentId = (session: Session) => {
  const parsed = associationSchema.safeParse(session.metadata);
  return session.parentID ? undefined : parsed.data?.openchamber.leadParentID;
};
const leadMarker = (session: Session | null | undefined) => {
  if (!session || session.parentID || leadParentId(session)) return undefined;
  return leadMetadataSchema.safeParse(session.metadata).data?.openchamber.lead;
};

export const isLeadSession = (session: Session | null | undefined) => Boolean(leadMarker(session));
export const leadDigest = (session: Session | null | undefined) => leadMarker(session)?.digest ?? null;

const directoryKey = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');
export const leadTargets = (sessions: Iterable<Session>, source: Session) => [...sessions].filter((target) => (
  target.id !== source.id && !target.time.archived && isLeadSession(target)
  && Boolean(target.directory && source.directory) && directoryKey(target.directory) === directoryKey(source.directory)
));

export const LEAD_REPLY_KEY = 'openchamberLeadAnswer';
const leadReplySchema = z.object({
  updatedAt: z.number(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
  suggestions: z.array(z.object({ item: z.string(), accepted: z.boolean() })),
});
export type LeadReply = Omit<z.infer<typeof leadReplySchema>, 'updatedAt'>;
export type LeadDigest = z.infer<typeof digestSchema>;

// Keep per-item receipts so a partial reply leaves unanswered items available.
export function leadReplyReceipts(messages: Message[], updatedAt: number): ReadonlySet<string> {
  const received = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const reply = leadReplySchema.safeParse(message.metadata?.[LEAD_REPLY_KEY]).data;
    if (!reply || reply.updatedAt !== updatedAt) continue;
    for (const { question } of reply.answers) received.add(`question:${question}`);
    for (const { item } of reply.suggestions) received.add(`suggestion:${item}`);
  }
  return received;
}

export function leadReplyText({ answers, suggestions }: LeadReply): string {
  const sections = ['Here is my reply to your lead digest.'];
  if (answers.length) sections.push('Answers:\n' + answers.map(({ question, answer }) => `- ${question}\n  ${answer}`).join('\n'));
  const accepted = suggestions.filter((entry) => entry.accepted).map(({ item }) => `- ${item}`);
  const declined = suggestions.filter((entry) => !entry.accepted).map(({ item }) => `- ${item}`);
  if (accepted.length) sections.push('Accepted:\n' + accepted.join('\n'));
  if (declined.length) sections.push('Declined:\n' + declined.join('\n'));
  return sections.join('\n\n');
}
