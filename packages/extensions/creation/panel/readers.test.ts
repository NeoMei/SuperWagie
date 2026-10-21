import { describe, expect, test } from 'bun:test';

import { confirmMessage, readWorkView, workFilePaths } from './readers.ts';

import plan from './fixtures/plan.json';
import prompts from './fixtures/sample-prompts.json';
import state from './fixtures/superppt.json';
import video from './fixtures/supervideo.json';
import writer from './fixtures/superwriter.json';

const deck = () => {
  const view = readWorkView('deck', { state: JSON.stringify(state), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) });
  if (!view) throw new Error('expected a deck view');
  return view;
};

describe('deck view', () => {
  test('maps plan-review to the selection gate', () => {
    const view = deck();
    expect(view.steps.map((step) => [step.label, step.state])).toEqual([
      ['方案', 'done'], ['选款', 'now'], ['样页', 'next'], ['整套', 'next'], ['交付', 'next'],
    ]);
    expect(view.gate?.key).toBe('deck-style');
    expect(view.gate?.title).toBe('选风格');
    expect(view.gate?.choices).toHaveLength(2);
    expect(view.gate?.choices?.[0]).toMatchObject({ styleId: 'glass', styleName: '玻璃', levels: [1, 2, 3] });
  });

  test('sample-review approves the whole deck', () => {
    const reviewing = { ...state, stage: 'sample-review', pendingDecision: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'sample-review' } };
    const view = readWorkView('deck', { state: JSON.stringify(reviewing), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) });
    expect(view?.gate?.key).toBe('deck-sample');
    expect(view?.steps[2]?.state).toBe('now');
    expect(confirmMessage('deck', view!.gate!)).toBe(
      `方案版本：${state.contentRevision}；决定编号：dddddddd-dddd-4ddd-8ddd-dddddddddddd；确认样页，生成整套。`,
    );
  });

  test('deck-review confirms delivery', () => {
    const reviewing = {
      ...state,
      stage: 'deck-review',
      pendingDecision: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'deck-review' },
      currentDeck: { revisionId: 'r', relativePath: '交付/季度汇报.pptx', sha256: 'a'.repeat(64) },
    };
    const view = readWorkView('deck', { state: JSON.stringify(reviewing), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) });
    expect(view?.gate?.key).toBe('deck-deliver');
    expect(view?.gate?.excerpt).toBe('交付/季度汇报.pptx');
  });

  test('another pending kind leaves the gate to the chat while the stage drives the strip', () => {
    const editing = { ...state, stage: 'deck-review', pendingDecision: { id: 'f', kind: 'edit-review' } };
    const view = readWorkView('deck', { state: JSON.stringify(editing), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) });
    expect(view?.gate).toBeNull();
    expect(view?.steps[3]?.state).toBe('now');
  });

  test('builds the exact tuple message from the selection', () => {
    const view = deck();
    const gate = view.gate;
    if (!gate) throw new Error('expected a gate');
    expect(confirmMessage('deck', gate, { styleId: 'glass', level: 2, paletteId: 'cool' })).toBe(
      `方案版本：${state.contentRevision}；决定编号：${state.pendingDecision.id}；选择玻璃，2 档，偏冷（glass/2/cool）；授权新增生图调用：1 次。`,
    );
  });

  test('refuses a selection whose prompt was not published', () => {
    const view = deck();
    const gate = view.gate;
    if (!gate) throw new Error('expected a gate');
    expect(confirmMessage('deck', gate, { styleId: 'glass', level: 3, paletteId: 'warm' })).toBeNull();
  });

  test('names the files it needs', () => {
    expect(workFilePaths('deck', JSON.stringify(state))).toEqual({
      plan: 'planning/22222222-2222-4222-8222-222222222222/plan.json',
      prompts: 'planning/22222222-2222-4222-8222-222222222222/sample-prompts.json',
    });
  });

  test('reports delivered with the current file', () => {
    const delivered = { ...state, stage: 'delivered', pendingDecision: null, delivery: { revisionId: 'r', relativePath: '交付/季度汇报.pptx', sha256: 'a'.repeat(64) } };
    const view = readWorkView('deck', { state: JSON.stringify(delivered), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) });
    expect(view?.deliveredPath).toBe('交付/季度汇报.pptx');
    expect(view?.steps.at(-1)?.state).toBe('now');
  });

  test('returns null for unknown or broken state', () => {
    expect(readWorkView('deck', { state: '{', plan: null, prompts: null })).toBeNull();
    expect(readWorkView('deck', { state: JSON.stringify({ ...state, schemaVersion: 'next' }), plan: null, prompts: null })).toBeNull();
  });

  test('returns null when the style gate has no readable plan', () => {
    expect(readWorkView('deck', { state: JSON.stringify(state), plan: null, prompts: null })).toBeNull();
  });

  test('no decision id means no confirmation text', () => {
    const gate = { key: 'deck-sample' as const, title: '样页', excerpt: '', version: '方案版本 abc', revision: 'abc' };
    expect(confirmMessage('deck', gate)).toBeNull();
  });

  test('refuses a selection with no revision even when a choice is passed', () => {
    const gate = deck().gate;
    if (!gate) throw new Error('expected a gate');
    expect(confirmMessage('deck', { ...gate, revision: undefined }, { styleId: 'glass', level: 2, paletteId: 'cool' })).toBeNull();
  });

  test('sample-review offers the rendered sample image', () => {
    const reviewing = { ...state, stage: 'sample-review', pendingDecision: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'sample-review' } };
    const result = JSON.stringify({ pages: [{ artifact: { path: 'generation/job/images/1.png' } }] });
    const view = readWorkView('deck', { state: JSON.stringify(reviewing), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts), result });
    expect(view?.gate?.media).toEqual([{ kind: 'image', label: '样页', path: 'generation/job/images/1.png' }]);
    expect(view?.gate?.openHint).toBeUndefined();
  });
});

describe('video view', () => {
  test('video steps follow approvals', () => {
    const view = readWorkView('video', { state: JSON.stringify(video) });
    expect(view?.steps.map((step) => step.state)).toEqual(['done', 'done', 'now', 'next', 'next']);
    expect(view?.gate?.key).toBe('video-sample');
    expect(view?.gate?.title).toBe('样片');
    expect(confirmMessage('video', view!.gate!)).toBe('确认当前样片（revision 7），按 SuperVideo 流程记录批准。');
  });

  test('video final gate needs the full render approval', () => {
    const withSample = { ...video, approvals: [...video.approvals, { id: 'a2', stage: 'sample', scope: ['s1', 's2'], digest: 'e', decision: 'approved', evidence: '可以' }] };
    const view = readWorkView('video', { state: JSON.stringify(withSample) });
    expect(view?.gate?.key).toBe('video-final');
    expect(view?.steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'now', 'next']);
  });

  test('no script approval keeps the script gate', () => {
    const view = readWorkView('video', { state: JSON.stringify({ ...video, approvals: [] }) });
    expect(view?.gate?.key).toBe('video-script');
    expect(view?.gate?.title).toBe('讲稿');
    expect(view?.steps.map((step) => step.state)).toEqual(['done', 'now', 'next', 'next', 'next']);
    expect(confirmMessage('video', view!.gate!)).toBe('确认当前讲稿（revision 7），按 SuperVideo 流程记录批准。');
  });

  test('a script approval must cover every scene', () => {
    const partial = { ...video, approvals: [{ id: 'a1', stage: 'script', scope: ['s1'], digest: 'd', decision: 'approved', evidence: '先看第一段' }] };
    expect(readWorkView('video', { state: JSON.stringify(partial) })?.gate?.key).toBe('video-script');
  });

  test('a waived script approval counts as current', () => {
    const waived = { ...video, approvals: [{ id: 'a1', stage: 'script', scope: ['s1', 's2'], digest: 'd', decision: 'waived', evidence: '用户说跳过' }] };
    const view = readWorkView('video', { state: JSON.stringify(waived) });
    expect(view?.steps.map((step) => step.state)).toEqual(['done', 'done', 'now', 'next', 'next']);
    expect(view?.gate?.key).toBe('video-sample');
  });

  test('two partial script approvals that together cover every scene finish the script', () => {
    const split = {
      ...video,
      approvals: [
        { id: 'a1', stage: 'script', scope: ['s1'], digest: 'd', decision: 'approved', evidence: '第一段可以' },
        { id: 'a2', stage: 'script', scope: ['s2'], digest: 'e', decision: 'approved', evidence: '第二段可以' },
      ],
    };
    const view = readWorkView('video', { state: JSON.stringify(split) });
    expect(view?.steps.map((step) => step.state)).toEqual(['done', 'done', 'now', 'next', 'next']);
    expect(view?.gate?.key).toBe('video-sample');
  });

  test('empty scenes are the brief step with no gate', () => {
    const view = readWorkView('video', { state: JSON.stringify({ ...video, scenes: [], approvals: [] }) });
    expect(view?.steps.map((step) => step.state)).toEqual(['now', 'next', 'next', 'next', 'next']);
    expect(view?.gate).toBeNull();
  });

  test('a final approval with a manifest path delivers the work', () => {
    const delivered = {
      ...video,
      approvals: [
        ...video.approvals,
        { id: 'a2', stage: 'sample', scope: ['s1', 's2'], digest: 'e', decision: 'approved', evidence: '可以' },
        { id: 'a3', stage: 'final', scope: ['s1', 's2'], digest: 'f', decision: 'approved', evidence: '交付', target: { manifestPath: '成片/交付/项目.json' } },
      ],
    };
    const view = readWorkView('video', { state: JSON.stringify(delivered) });
    expect(view?.gate).toBeNull();
    expect(view?.steps.at(-1)).toMatchObject({ label: '交付', state: 'now' });
    expect(view?.deliveredPath).toBe('成片/交付/项目.json');
  });

  test('the excerpt is the first two scenes, cut at 200 characters', () => {
    const view = readWorkView('video', { state: JSON.stringify(video) });
    expect(view?.gate?.excerpt).toBe('第一句 / 第二句');
    const long = {
      ...video,
      scenes: [
        { id: 's1', title: '开场', sentences: [{ id: 't1', text: '甲'.repeat(150) }] },
        { id: 's2', title: '卖点', sentences: [{ id: 't2', text: '乙'.repeat(150) }] },
        { id: 's3', title: '结尾', sentences: [{ id: 't3', text: '丙' }] },
      ],
    };
    const cut = readWorkView('video', { state: JSON.stringify(long) });
    expect(cut?.gate?.excerpt).toHaveLength(200);
    expect(cut?.gate?.excerpt.includes('丙')).toBe(false);
  });

  test('a video gate without a revision has no confirmation text', () => {
    const view = readWorkView('video', { state: JSON.stringify(video) });
    expect(confirmMessage('video', { ...view!.gate!, revision: undefined })).toBeNull();
  });

  test('returns null for unknown or broken video state', () => {
    expect(readWorkView('video', { state: '{' })).toBeNull();
    expect(readWorkView('video', { state: JSON.stringify({ ...video, schemaVersion: 2 }) })).toBeNull();
    expect(readWorkView('video', { state: JSON.stringify({ ...video, scenes: 'none' }) })).toBeNull();
  });

  test('sample gate offers the rendered sample video', () => {
    const withJob = {
      ...video,
      jobs: [{ kind: 'render', state: 'succeeded', request: { kind: 'sample' }, manifestPath: 'renders/r1/manifest.json' }],
    };
    const view = readWorkView('video', { state: JSON.stringify(withJob) });
    expect(view?.gate?.media).toEqual([{ kind: 'video', label: '样片', path: 'renders/r1/video.mp4' }]);
  });
});

describe('document view', () => {
  test('document gate names the chapter and the version', () => {
    const view = readWorkView('doc', { state: JSON.stringify(writer), artifact: '# 第三章\n\n接口设计...' });
    expect(view?.gate?.key).toBe('doc-review');
    expect(view?.gate?.title).toBe('第 3/3 章');
    expect(view?.gate?.excerpt).toContain('接口设计');
    expect(confirmMessage('doc', view!.gate!)).toBe('确认第 3/3 章（对象 chapter-3，版本 1，revision 12），按 SuperWriter 流程记录批准。');
  });

  test('document steps show the chapter loop position', () => {
    const view = readWorkView('doc', { state: JSON.stringify(writer), artifact: '' });
    expect(view?.steps.map((step) => step.label)).toEqual(['需求', '方案', '大纲', '第 3 章', '配图', '合稿', '导出']);
  });

  test('an approved outline asks for the manuscript, not a chapter', () => {
    const done = {
      ...writer,
      objects: Object.fromEntries(Object.entries(writer.objects).map(([id, object]) => [id, { ...object, status: 'approved' }])),
      stage: 'manuscript',
      active_object_id: 'manuscript',
    };
    const view = readWorkView('doc', { state: JSON.stringify(done), artifact: '' });
    expect(view?.gate?.key).toBe('doc-review');
    expect(view?.gate?.title).toBe('合稿');
  });

  test('names the active chapter file', () => {
    expect(workFilePaths('doc', JSON.stringify(writer))).toEqual({ artifact: '章节/第三章.md' });
  });

  test('a verified delivery is the delivered path', () => {
    const delivered = {
      ...writer,
      objects: {
        ...writer.objects,
        delivery: { id: 'delivery', kind: 'delivery', path: '合稿/最终稿.docx', version: 1, sha256: 'f', dependencies: {}, status: 'verified', metadata: {} },
      },
    };
    const view = readWorkView('doc', { state: JSON.stringify(delivered), artifact: '' });
    expect(view?.deliveredPath).toBe('合稿/最终稿.docx');
  });

  test('the outline stage reports no chapter position', () => {
    const view = readWorkView('doc', { state: JSON.stringify({ ...writer, stage: 'outline', active_object_id: 'outline' }), artifact: '' });
    expect(view?.steps[3]?.label).toBe('章节');
  });

  test('a chapter outside the order reports no position', () => {
    const extra = {
      ...writer,
      active_object_id: 'chapter-4',
      objects: {
        ...writer.objects,
        'chapter-4': { id: 'chapter-4', kind: 'chapter', path: '章节/第四章.md', version: 1, sha256: 'g', dependencies: { outline: 3 }, status: 'pending_review', metadata: {} },
      },
    };
    const view = readWorkView('doc', { state: JSON.stringify(extra), artifact: '' });
    expect(view?.steps[3]?.label).toBe('章节');
    expect(view?.gate?.title).toBe('这一章');
  });

  test('the gate carries the revision as its decision id', () => {
    const view = readWorkView('doc', { state: JSON.stringify(writer), artifact: '' });
    expect(view?.gate?.decisionId).toBe(String(writer.revision));
  });

  test('a figure gate is labelled as figures', () => {
    const figure = {
      ...writer,
      stage: 'illustrations',
      active_object_id: 'figure-1',
      objects: {
        ...writer.objects,
        'figure-1': { id: 'figure-1', kind: 'figure', path: '配图/示意图.md', version: 1, sha256: 'h', dependencies: { 'chapter-1': 2 }, status: 'pending_review', metadata: {} },
      },
    };
    const view = readWorkView('doc', { state: JSON.stringify(figure), artifact: '' });
    expect(view?.gate?.title).toBe('配图');
  });

  test('a layout gate is labelled as layout', () => {
    const layout = {
      ...writer,
      stage: 'manuscript',
      active_object_id: 'layout',
      objects: {
        ...writer.objects,
        layout: { id: 'layout', kind: 'layout', path: '版式.md', version: 1, sha256: 'i', dependencies: {}, status: 'pending_review', metadata: {} },
      },
    };
    const view = readWorkView('doc', { state: JSON.stringify(layout), artifact: '' });
    expect(view?.gate?.title).toBe('版式');
  });

  test('falls back to the single outline object when the key is renamed', () => {
    const renamed = {
      ...writer,
      objects: Object.fromEntries(Object.entries(writer.objects).map(([id, object]) => [id === 'outline' ? 'outline-main' : id, object])),
    };
    const view = readWorkView('doc', { state: JSON.stringify(renamed), artifact: '' });
    expect(view?.steps[3]?.label).toBe('第 3 章');
    expect(view?.gate?.title).toBe('第 3/3 章');
  });

  test('returns null for broken state and unknown stages', () => {
    expect(readWorkView('doc', { state: '{' })).toBeNull();
    expect(readWorkView('doc', { state: JSON.stringify({ ...writer, stage: 'archived' }) })).toBeNull();
  });

  test('the excerpt keeps three lines and shortens long ones', () => {
    const long = '图'.repeat(100);
    const view = readWorkView('doc', { state: JSON.stringify(writer), artifact: `标题\n${long}\n第三行\n第四行` });
    const lines = view?.gate?.excerpt.split('\n') ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('图'.repeat(80));
    expect(lines[2]).toBe('第三行');
  });
});
