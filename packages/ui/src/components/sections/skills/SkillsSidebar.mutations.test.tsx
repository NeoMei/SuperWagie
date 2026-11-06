import { beforeEach, expect, test } from 'bun:test';
import { setup, act, mount, unmount, deferred, setResponder, defaultResponse, useSkillsStore, switchTo, detail, success, error, button, change } from './skillMutationTestUtils';
const { SkillsSidebar } = await import('./SkillsSidebar');
beforeEach(setup);
const menu = async (label: string) => {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  if (!trigger) throw new Error('Missing skill menu');
  await act(async () => trigger.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === label);
  if (!item) throw new Error(`Missing ${label}`); await act(async () => item.click());
};
for (const change of ['runtime', 'selection', 'unmount']) {
  test(`duplicate cannot replace newer draft after ${change}`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.path === '/api/config/skills/lab' && entry.method === 'GET' ? held.promise : defaultResponse(entry));
    await mount(<SkillsSidebar />); await menu('Duplicate');
    if (change === 'unmount') await unmount();
    else await act(async () => { if (change === 'runtime') switchTo('b'); else { useSkillsStore.getState().setSelectedSkill('other'); useSkillsStore.getState().setSelectedSkill('lab'); } });
    const newer = { name: 'newer', scope: 'user' as const, description: 'B draft' };
    await act(async () => useSkillsStore.setState({ skillDraft: newer })); success.mockClear(); error.mockClear();
    await act(async () => held.finish(Response.json(detail())));
    expect(useSkillsStore.getState().skillDraft).toBe(newer); expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
}
test('current sidebar deletion clears only its own selection and reports success', async () => {
  await mount(<SkillsSidebar />); await menu('Delete');
  await act(async () => button('Delete', '[role="dialog"] button').click());
  expect(useSkillsStore.getState().selectedSkillName).toBeNull(); expect(success).toHaveBeenCalledTimes(1);
});
test('rename completion preserves a same-name selection round trip', async () => {
  const held = deferred<Response>();
  setResponder(async (entry) => entry.method === 'PATCH' ? held.promise : defaultResponse(entry));
  await mount(<SkillsSidebar />); await menu('Rename');
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  if (!input) throw new Error('Missing rename input'); await change(input, 'renamed');
  await act(async () => button('Rename', '[role="dialog"] button').click());
  await act(async () => { useSkillsStore.getState().setSelectedSkill('other'); useSkillsStore.getState().setSelectedSkill('lab'); });
  success.mockClear(); error.mockClear(); await act(async () => held.finish(Response.json({})));
  expect(useSkillsStore.getState().selectedSkillName).toBe('lab'); expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
