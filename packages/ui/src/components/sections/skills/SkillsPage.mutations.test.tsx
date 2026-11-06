import { beforeEach, expect, test } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { setup, act, mount, button, change, deferred, setResponder, defaultResponse, success, error,
  requests, mutations, switchTo, useSkillsStore, useUIStore, skill, detail, unexpected } from './skillMutationTestUtils';
const { SkillsPage } = await import('@/components/sections/skills/SkillsPage');
beforeEach(setup);
for (const ownerChange of ['runtime', 'directory']) {
  test(`old rendered Create skill cannot dispatch after synchronous ${ownerChange} change`, async () => {
    useSkillsStore.setState({ selectedSkillName: 'new', skillDraft: { name: 'new', scope: 'user', description: 'A draft', instructions: 'A body' } });
    await mount(<SkillsPage />);
    const create = button('Create skill');
    await act(async () => {
      if (ownerChange === 'runtime') switchTo('b');
      else useUIStore.setState({ settingsProjectPath: '/other' });
      create.click();
    });
    expect(mutations()).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
test('current create submits its rendered draft to A', async () => {
  useSkillsStore.setState({ selectedSkillName: 'new', skillDraft: { name: 'new', scope: 'user', description: 'A draft', instructions: 'A body' } });
  await mount(<SkillsPage />); await act(async () => button('Create skill').click());
  expect(mutations().map(({ host, method, path, body }) => [host, method, path, body])).toEqual([
    ['skill-a.invalid', 'POST', '/api/config/skills/new', '{"name":"new","description":"A draft","instructions":"A body","scope":"user","source":"opencode"}'],
  ]);
  expect(unexpected).toEqual([]);
});
for (const readState of ['pending', 'failed']) {
  test(`new B visit cannot save A dirty content while B detail is ${readState}`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.host === 'skill-b.invalid' && entry.path === '/api/config/skills/lab' && entry.method === 'GET'
      ? held.promise : defaultResponse(entry));
    await mount(<SkillsPage />);
    const description = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="What does this skill do?"]')
      ?? [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((field) => field.value === 'lab description');
    if (!description) throw new Error('Missing hydrated description');
    await change(description, 'Unsaved A description');
    expect(mutations()).toEqual([]);
    await act(async () => {
      switchTo('b');
      useSkillsStore.setState({ selectedSkillName: 'lab', skills: [skill()], skillsByDirectory: { '/fixture': [skill()] }, policiesByDirectory: { '/fixture': [] } });
    });
    if (readState === 'failed') await act(async () => held.finish(Response.json({ error: 'B detail unavailable' }, { status: 500 })));
    try {
      const field = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find((node) => node.value === 'Unsaved A description');
      if (field) await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
      expect(mutations()).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally { await act(async () => held.finish(Response.json(detail('lab', 'B saved body')))); }
  });
}

const withFiles = () => {
  const value = detail();
  return { ...value, sources: { md: { ...value.sources.md, supportingFiles: [
    { name: 'old.md', path: 'old.md', fullPath: '/fixture/.opencode/skills/lab/old.md' },
    { name: 'next.md', path: 'next.md', fullPath: '/fixture/.opencode/skills/lab/next.md' },
  ] } } };
};
const openFile = async (path: string) => {
  const label = [...document.querySelectorAll<HTMLElement>('span')].find((node) => node.textContent === path);
  if (!label?.parentElement) throw new Error(`Missing supporting file ${path}`);
  await act(async () => label.parentElement?.click());
};
const content = () => {
  const node = document.querySelector<HTMLElement>('[role="dialog"] .cm-editor');
  if (!node) throw new Error('Missing supporting-file editor');
  const editor = EditorView.findFromDOM(node);
  if (!editor) throw new Error('Missing supporting-file editor instance');
  return editor.state.doc.toString();
};
for (const ownerChange of ['dialog', 'runtime']) {
  test(`old supporting-file read cannot hydrate newer ${ownerChange} visit`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => {
      if (entry.path === '/api/config/skills/lab' && entry.method === 'GET') return Response.json(withFiles());
      if (entry.path.endsWith('/files/old.md') && entry.method === 'GET') return held.promise;
      if (entry.path.endsWith('/files/next.md') && entry.method === 'GET') return Response.json({ content: 'Current next.md body' });
      return defaultResponse(entry);
    });
    await mount(<SkillsPage />); await openFile('old.md');
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] [data-slot="dialog-close"]');
    if (!close) throw new Error('Missing file-dialog close control');
    await act(async () => close.click());
    if (ownerChange === 'runtime') await act(async () => {
      switchTo('b');
      useSkillsStore.setState({ selectedSkillName: 'lab', skills: [skill()], skillsByDirectory: { '/fixture': [skill()] }, policiesByDirectory: { '/fixture': [] } });
    });
    await openFile('next.md');
    expect(content()).toBe('Current next.md body');
    await act(async () => held.finish(Response.json({ content: 'Retired old.md body' })));
    expect(content()).toBe('Current next.md body');
    expect(unexpected).toEqual([]);
  });
}
test('current supporting-file read hydrates its own dialog', async () => {
  setResponder(async (entry) => entry.path === '/api/config/skills/lab' && entry.method === 'GET' ? Response.json(withFiles())
    : entry.path.endsWith('/files/old.md') && entry.method === 'GET' ? Response.json({ content: 'Current old.md body' }) : defaultResponse(entry));
  await mount(<SkillsPage />); await openFile('old.md');
  expect(content()).toBe('Current old.md body'); expect(unexpected).toEqual([]);
});
for (const action of ['write', 'delete']) {
  test(`supporting-file ${action} cannot refresh or report into a newer selection visit`, async () => {
    const held = deferred<Response>();
    setResponder(async (entry) => entry.path === '/api/config/skills/lab' && entry.method === 'GET' ? Response.json(withFiles())
      : entry.method === (action === 'write' ? 'PUT' : 'DELETE') && entry.path.includes('/files/') ? held.promise : defaultResponse(entry));
    await mount(<SkillsPage />);
    if (action === 'write') {
      await act(async () => button('Add file').click());
      const path = document.querySelector<HTMLInputElement>('[role="dialog"] input');
      if (!path) throw new Error('Missing supporting-file path'); await change(path, 'new.md');
      await act(async () => button('Create file', '[role="dialog"] button').click());
    } else {
      const label = [...document.querySelectorAll<HTMLElement>('span')].find((node) => node.textContent === 'old.md');
      const remove = label?.parentElement?.querySelector<HTMLButtonElement>('button');
      if (!remove) throw new Error('Missing file delete'); await act(async () => remove.click());
      await act(async () => button('Delete', '[role="dialog"] button').click());
    }
    expect(mutations()).toHaveLength(1);
    await act(async () => { useSkillsStore.getState().setSelectedSkill('other'); useSkillsStore.getState().setSelectedSkill('lab'); });
    const before = requests.length; success.mockClear(); error.mockClear();
    await act(async () => held.finish(Response.json({})));
    expect(requests.slice(before).filter((entry) => entry.path === '/api/config/skills/lab')).toEqual([]);
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
}
