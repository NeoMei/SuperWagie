import { beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { setup, act, mount, button, deferred, setResponder, defaultResponse, useSkillsCatalogStore, item, source, success, error, requests } from '../skillMutationTestUtils';
const { InstallSkillDialog } = await import('./InstallSkillDialog');
beforeEach(setup);
for (const outcome of ['success', 'conflicts']) {
  test(`old install ${outcome} cannot affect a reopened dialog`, async () => {
    const held = deferred<Response>(); const closes: boolean[] = []; const selected = item('lab');
    useSkillsCatalogStore.setState({ sources: [source], itemsBySource: { fixture: [selected] }, loadedSourceIds: { fixture: true } });
    setResponder(async (entry) => entry.path.endsWith('/skills/install') ? held.promise : defaultResponse(entry));
    const Fixture = () => {
      const [open, setOpen] = React.useState(true);
      return <><button onClick={() => setOpen(true)}>Reopen</button><InstallSkillDialog open={open} items={[selected]} onOpenChange={(value) => { closes.push(value); setOpen(value); }} /></>;
    };
    await mount(<Fixture />); await act(async () => button('Install', '[role="dialog"] button').click());
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] [data-slot="dialog-close"]');
    if (!close) throw new Error('Missing dialog close');
    await act(async () => close.click()); await act(async () => button('Reopen').click());
    success.mockClear(); error.mockClear();
    await act(async () => held.finish(Response.json(outcome === 'success' ? { ok: true, installed: [] }
      : { ok: false, error: { kind: 'conflicts', message: 'A conflicts', conflicts: [{ skillName: 'old-conflict', scope: 'user' }] } })));
    expect(closes).toEqual([false]); expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('old-conflict');
  });
}
test('current install preserves conflict retry and refreshes its source before closing', async () => {
  const selected = item('lab'); const closes: boolean[] = []; let installs = 0;
  useSkillsCatalogStore.setState({ sources: [source], itemsBySource: { fixture: [selected] }, loadedSourceIds: { fixture: true } });
  setResponder(async (entry) => entry.path.endsWith('/skills/install')
    ? Response.json(++installs === 1 ? { ok: false, error: { kind: 'conflicts', message: 'Existing lab', conflicts: [{ skillName: 'lab', scope: 'user' }] } } : { ok: true, installed: [] }) : defaultResponse(entry));
  await mount(<InstallSkillDialog open items={[selected]} onOpenChange={(value) => closes.push(value)} />);
  await act(async () => button('Install', '[role="dialog"] button').click());
  await act(async () => button('Continue', '[role="dialog"] button').click());
  const writes = requests.filter((entry) => entry.path.endsWith('/skills/install'));
  expect(writes).toHaveLength(2);
  expect(JSON.parse(writes[1]?.body ?? '{}')).toMatchObject({ conflictPolicy: 'prompt', conflictDecisions: { lab: 'skip' } });
  expect(requests.some((entry) => entry.path.endsWith('/catalog/source'))).toBe(true);
  expect(closes).toEqual([false]); expect(success).toHaveBeenCalledTimes(1);
});
