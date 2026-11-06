import { beforeEach, expect, test } from 'bun:test';
import { setup, act, mount, unmount, button, deferred, setResponder, defaultResponse, useSkillsStore, skill, until, mutations } from './skillMutationTestUtils';
const { SkillUseField } = await import('./SkillUseField');
beforeEach(setup);
for (const ownerChange of ['selection', 'unmount']) {
  test(`pending enable cannot change manual flag after ${ownerChange}`, async () => {
    const held = deferred<Response>(); const changed: boolean[] = [];
    useSkillsStore.setState({ policiesByDirectory: { '/fixture': [{ resource: 'skill:lab', effect: 'deny', path: '/fixture/opencode.json' }] } });
    setResponder(async (entry) => entry.path === '/api/config/skill-switch' ? held.promise : defaultResponse(entry));
    await mount(<SkillUseField skill={skill()} directory="/fixture" manual={false} manualLocked={false} onManualChange={(value) => changed.push(value)} />);
    await act(async () => button('When called').click()); await until(() => mutations().length === 1);
    if (ownerChange === 'unmount') await unmount();
    else await act(async () => { useSkillsStore.getState().setSelectedSkill('other'); useSkillsStore.getState().setSelectedSkill('lab'); });
    await act(async () => held.finish(Response.json({ changed: ['/fixture/opencode.json'] })));
    expect(changed).toEqual([]);
  });
}
test('current enable completes the requested manual flag change', async () => {
  const changed: boolean[] = [];
  useSkillsStore.setState({ policiesByDirectory: { '/fixture': [{ resource: 'skill:lab', effect: 'deny', path: '/fixture/opencode.json' }] } });
  await mount(<SkillUseField skill={skill()} directory="/fixture" manual={false} manualLocked={false} onManualChange={(value) => changed.push(value)} />);
  await act(async () => button('When called').click()); expect(changed).toEqual([true]);
});
