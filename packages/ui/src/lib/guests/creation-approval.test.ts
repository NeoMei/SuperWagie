import { expect, test } from 'bun:test';
import { runCreationApprovalRequest, type CreationApprovalResult, type CreationApprovalsAPI } from './creation-approval';

const inspection = { kind: 'deck' as const, stage: 'deck-sample', decisionId: 'decision-a', artifactVersion: 'a'.repeat(64) };
const initial = { ...inspection, id: 'b'.repeat(64), acceptedAt: 1, status: 'unknown' as const, dispatch: 'unknown' as const };
const submit = { method: 'POST' as const, path: '/api/creation/decision', body: JSON.stringify({ action: 'submit', inspection, text: 'Approve the sample' }) };
const fixture = () => {
  const receipt = { ...initial };
  let claimed = false;
  let sends = 0;
  let failClaimResponse = false;
  let failSend = false;
  let current = true;
  const api: CreationApprovalsAPI = { perform: async (input): Promise<CreationApprovalResult> => {
    if (input.action === 'claim') {
      const dispatch = !claimed; claimed = true;
      if (failClaimResponse) { failClaimResponse = false; throw new Error('lost response after durable claim'); }
      return { type: 'claim', dispatch, receipt };
    }
    if (input.action === 'settle') {
      const accepted = { ...initial, status: 'accepted' as const, dispatch: 'confirmed' as const };
      return { type: 'receipt', receipt: accepted };
    }
    return { type: 'inspection', inspection, receipt: claimed ? receipt : null };
  } };
  const run = (request = submit) => runCreationApprovalRequest({ request, api, directory: '/registered', sessionId: 'session', assertCurrent: () => { if (!current) throw new Error('retired'); }, send: async () => { expect(claimed).toBe(true); sends++; if (failSend) throw new Error('response lost after downstream send'); return { sent: 'sent' }; } });
  return { run, get sends() { return sends; }, loseClaim: () => { failClaimResponse = true; }, loseSend: () => { failSend = true; }, retire: () => { current = false; } };
};

test('host dispatches only the newly claimed action and reports admission separately from completion', async () => {
  const f = fixture();
  expect(JSON.parse((await f.run()).body).receipt.status).toBe('accepted');
  await f.run();
  expect(f.sends).toBe(1);
});
test('lost claim and send responses never cause automatic replay', async () => {
  const claim = fixture(); claim.loseClaim();
  await expect(claim.run()).rejects.toThrow('lost response');
  expect(JSON.parse((await claim.run()).body).receipt.status).toBe('unknown');
  expect(claim.sends).toBe(0);
  const send = fixture(); send.loseSend();
  expect(JSON.parse((await send.run()).body).receipt.status).toBe('unknown');
  await send.run();
  expect(send.sends).toBe(1);
});
test('missing native authority leaves the ordinary prompt path available to its caller', async () => {
  const result = await runCreationApprovalRequest({ request: { ...submit, body: JSON.stringify({ action: 'inspect', kind: 'deck', state: '{}', observed: { plan: null, prompts: null, directions: null, artifact: null, result: null } }) }, api: undefined, directory: '/registered', sessionId: 'session', assertCurrent: () => {}, send: async () => { throw new Error('must not dispatch'); } });
  expect(result.status).toBe(501);
  expect(JSON.parse(result.body).type).toBe('unavailable');
});
test('host admission rejects ownership retired during the awaited native result before it can send', async () => {
  let current = true;
  let sends = 0;
  const api: CreationApprovalsAPI = { perform: async () => { current = false; return { type: 'claim', dispatch: true, receipt: initial }; } };
  await expect(runCreationApprovalRequest({ request: submit, api, directory: '/registered', sessionId: 'session', assertCurrent: () => { if (!current) throw new Error('retired original frame/account'); },
    send: async () => { sends++; return { sent: 'sent' }; },
  })).rejects.toThrow('retired');
  expect(sends).toBe(0);
});
