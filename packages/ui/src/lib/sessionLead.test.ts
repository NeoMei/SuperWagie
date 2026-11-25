import { describe, expect, test } from 'bun:test';
import type { Session, UserMessage } from '@/lib/opencode/model';
import { LEAD_REPLY_KEY, leadDigest, leadReplyReceipts, leadReplyText, leadTargets } from './sessionLead';

const session = (id: string, directory: string, extras: Partial<Session> = {}): Session => ({
  id, directory, title: id, projectID: 'project', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, ...extras,
});

describe('Lead UI contract', () => {
  test('ignores inherited marks and excludes peers in other locations or archives', () => {
    const metadata = { openchamber: { lead: { at: 1, digest: { updatedAt: 2, needsYou: ['Proceed?'] } } } };
    const lead = session('ses_lead', '/repo', { metadata });
    const child = session('ses_child', '/repo', { parentID: lead.id, metadata });
    const elsewhere = session('ses_other', '/elsewhere', { metadata });
    const archived = session('ses_archived', '/repo', { metadata, time: { created: 1, updated: 1, archived: 2 } });
    expect(leadDigest(child)).toBeNull();
    expect(leadDigest(lead)?.needsYou).toEqual([{ question: 'Proceed?', options: [] }]);
    expect(leadTargets([lead, child, elsewhere, archived], session('ses_job', '/repo'))).toEqual([lead]);
  });

  test('uses only the submitted items from the current digest revision', () => {
    const metadata = { [LEAD_REPLY_KEY]: {
      updatedAt: 5,
      answers: [{ question: 'Proceed?', answer: 'Yes' }],
      suggestions: [{ item: 'Update docs', accepted: false }],
    } };
    const messages: UserMessage[] = [{ id: 'msg_reply', sessionID: 'ses_lead', role: 'user', time: { created: 6 }, metadata }];
    expect([...leadReplyReceipts(messages, 5)]).toEqual(['question:Proceed?', 'suggestion:Update docs']);
    expect(leadReplyReceipts(messages, 6).size).toBe(0);
  });

  test('keeps answers and both suggestion decisions together in one prompt', () => {
    const text = leadReplyText({
      answers: [{ question: 'Proceed?', answer: 'Wait for approval' }],
      suggestions: [{ item: 'Update the guide', accepted: true }, { item: 'Reformat it', accepted: false }],
    });
    expect(text).toContain('Proceed?');
    expect(text).toContain('Wait for approval');
    expect(text).toContain('Accepted:\n- Update the guide');
    expect(text).toContain('Declined:\n- Reformat it');
  });
});
