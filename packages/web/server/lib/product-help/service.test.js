import { describe, expect, it } from 'vitest';
import { getProductHelpArticles } from './catalog.js';
import { answerProductHelp } from './service.js';

const INPUT = { question: '怎么配置第一个模型？', locale: 'zh-CN', context: { page: 'chat' }, directory: '/active-project' };
const SELECTED = { ...INPUT, providerID: 'selected-provider', modelID: 'selected-model' };
const model = { providerID: 'selected-provider', modelID: 'small-model', source: 'session-provider-small', hasLogin: true };
const selecting = (articleIds, kind = 'answer') => async () => ({ text: JSON.stringify({ kind, articleIds }) });
const offline = { describeModel: async () => null };

describe('product help answers', () => {
  it('answers first-model setup with bundled help before a provider exists', async () => {
    const result = await answerProductHelp(INPUT, offline);
    expect(result).toMatchObject({ kind: 'answer', mode: 'local', modelStatus: 'unconfigured', sources: [{ id: 'models-first-connection' }] });
    expect(result.actions).toEqual([
      { id: 'models-locate', kind: 'locate', target: 'models' },
      { id: 'models-guide', kind: 'guide', target: 'models' },
    ]);
    expect(result.text).toContain('OpenCode');
  });

  it('does no model discovery without an active/default directory', async () => {
    const { directory: _directory, ...input } = INPUT;
    const result = await answerProductHelp(input, { describeModel: async () => { throw new Error('must not query an unscoped OpenCode location'); } });
    expect(result.modelStatus).toBe('unconfigured');
  });

  it.each(['帮我写一份报告', '写一份关于 SuperWagie 的报告', 'Write a report about SuperWagie', '请写一份关于如何配置模型的报告', 'Write a report explaining how to configure models', '请帮我制定项目预算', '今天的天气怎么样'])('refuses unrelated work without calling a model: %s', async (question) => {
    let discoveries = 0;
    const result = await answerProductHelp({ ...SELECTED, question }, { describeModel: async () => { discoveries++; return model; } });
    expect(result).toMatchObject({ kind: 'out-of-scope', sources: [], actions: [], mode: 'local' });
    expect(discoveries).toBe(0);
  });

  it('explains how to use the product for report writing without writing a report', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '怎么用 SuperWagie 写报告？' }, offline);
    expect(result.sources[0].id).toBe('report-workflow');
    expect(result.text).toContain('普通对话');
  });

  it('still accepts a direct request to explain a product failure', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '请帮我分析模型连接失败原因' }, offline);
    expect(result.sources[0].id).toBe('models-test');
  });

  it('preserves a knowledge-library follow-up and chooses specific failure help', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '失败了怎么办？', history: [{ role: 'user', text: '知识库怎么导入资料？' }] }, offline);
    expect(result.sources[0].id).toBe('knowledge-failure');
  });

  it.each(['怎么用 Python 写网页？', '如何使用 Photoshop？', 'How to import a Python package?', '怎么引导孩子学习？'])('does not confuse generic how-to wording with product usage: %s', async (question) => {
    const result = await answerProductHelp({ ...INPUT, question }, offline);
    expect(result).toMatchObject({ kind: 'out-of-scope', sources: [], actions: [] });
  });

  it('keeps general product onboarding in scope without accepting all how-to questions', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '这个产品如何使用？' }, offline);
    expect(result.sources[0].id).toBe('assistant-guidance');
  });

  it('keeps the original topic through successive topic-free follow-ups', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '失败了怎么办？', history: [
      { role: 'user', text: '知识库怎么导入资料？' },
      { role: 'user', text: '下一步呢？' },
    ] }, offline);
    expect(result.sources[0].id).toBe('knowledge-failure');
  });

  it('uses only recognized reviewed assistant text when the original question has left history', async () => {
    const article = getProductHelpArticles('zh-CN').find((entry) => entry.id === 'knowledge-setup');
    const result = await answerProductHelp({ ...INPUT, question: '失败了怎么办？', history: [
      { role: 'assistant', text: `${article.title}\n\n${article.text}` },
      { role: 'user', text: '下一步呢？' },
    ] }, offline);
    expect(result.sources[0].id).toBe('knowledge-failure');
    const unreviewed = await answerProductHelp({ ...INPUT, question: '下一步呢？', history: [
      { role: 'assistant', text: 'Unverified advice about knowledge library.' },
    ] }, offline);
    expect(unreviewed.kind).toBe('not-covered');
  });

  it('lets an explicit new topic replace the previous topic', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '那怎么改主题？', history: [
      { role: 'user', text: '怎么配置模型？' },
    ] }, offline);
    expect(result.sources[0].id).toBe('appearance-theme');
  });

  it('does not inherit product scope just because an unrelated question starts with a follow-up word', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '那如何使用 Python？', history: [
      { role: 'user', text: '怎么配置模型？' },
    ] }, offline);
    expect(result).toMatchObject({ kind: 'out-of-scope', sources: [], actions: [] });
  });

  it('resolves current-page questions from an explicit fixed page id', async () => {
    const result = await answerProductHelp({ ...INPUT, question: '这个页面怎么用？', context: { page: 'settings:models' } }, offline);
    expect(result.sources[0].id).toBe('models-purpose');
  });

  it.each(['settings:constructor', 'settings:__proto__', 'toString'])('never resolves inherited object properties as help articles: %s', async (page) => {
    const result = await answerProductHelp({ ...INPUT, question: '这个页面怎么用？', context: { page } }, offline);
    expect(result.kind).not.toBe('answer');
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.sources).toEqual([]);
  });

  it('distinguishes an uncovered product question from an unrelated question', async () => {
    const result = await answerProductHelp({ ...INPUT, question: 'SuperWagie 是否支持量子通信？' }, offline);
    expect(result).toMatchObject({ kind: 'not-covered', sources: [], actions: [] });
  });

  it.each(['skills', 'plugins-extensions', 'workbench', 'projects-chats', 'report-workflow', 'assistant-guidance'])('keeps %s available with no invented navigation action', (id) => {
    const article = getProductHelpArticles('en').find((entry) => entry.id === id);
    expect(article.text.length).toBeGreaterThan(80);
    expect(article.actions).toEqual([]);
  });

  it('offers guides only for complete supported tasks and keeps theme and font separate', () => {
    const articles = getProductHelpArticles('en');
    expect(articles.filter((article) => article.actions.some((action) => action.kind === 'guide')).map((article) => article.id))
      .toEqual(['models-first-connection', 'appearance-language']);
    expect(articles.find((article) => article.id === 'appearance-theme').actions)
      .toEqual([
        { id: 'theme-locate', kind: 'locate', target: 'theme' },
        { id: 'theme-light', kind: 'execute', operation: 'theme-light' },
        { id: 'theme-dark', kind: 'execute', operation: 'theme-dark' },
        { id: 'theme-system', kind: 'execute', operation: 'theme-system' },
      ]);
    expect(articles.find((article) => article.id === 'appearance-font').actions).toEqual([]);
    for (const id of ['models-purpose', 'models-test', 'knowledge-setup', 'knowledge-search', 'knowledge-failure', 'shortcuts']) {
      expect(articles.find((article) => article.id === id).actions.map((action) => action.kind)).toEqual(['locate']);
    }
  });

  it('offers only registered operations for language and appearance requests', async () => {
    const language = await answerProductHelp({ question: '帮我切换成英文', locale: 'zh-CN' });
    expect(language.actions.filter(action => action.kind === 'execute')).toEqual([
      { id: 'language-en', kind: 'execute', operation: 'language-en' },
      { id: 'language-zh-CN', kind: 'execute', operation: 'language-zh-CN' },
    ]);
    const theme = await answerProductHelp({ question: '帮我切换深色模式', locale: 'zh-CN' });
    expect(theme.actions.filter(action => action.kind === 'execute').map(action => action.operation))
      .toEqual(['theme-light', 'theme-dark', 'theme-system']);
    const unrelated = await answerProductHelp({ question: '帮我写一首诗', locale: 'zh-CN' });
    expect(unrelated.actions).toEqual([]);
  });

  it('uses semantic matching while returning only reviewed prose and controlled actions', async () => {
    let call;
    const result = await answerProductHelp({ ...SELECTED, question: 'I need the place that changes the interface to English.', locale: 'en' }, {
      describeModel: async () => model,
      generateText: async (args) => { call = args; return selecting(['appearance-language'])(); },
    });
    expect(result).toMatchObject({ kind: 'answer', mode: 'model', modelStatus: 'available', sources: [{ id: 'appearance-language' }] });
    expect(result.text).toContain('Settings → Appearance');
    expect(call.model).toBe('selected-provider/small-model');
    expect(call.directory).toBe('/active-project');
    expect(call.onOverflow).toBe('error');
    expect(call).not.toHaveProperty('tools');
    const prompt = JSON.parse(call.prompt);
    expect(prompt).not.toHaveProperty('directory');
    expect(prompt).not.toHaveProperty('sessionId');
    expect(prompt.articles.length).toBe(16);
  });

  it('passes only bounded assistant history to semantic matching', async () => {
    const history = [{ role: 'user', text: 'Where do I choose a model?' }, { role: 'assistant', text: 'Open model settings.' }];
    let prompt;
    await answerProductHelp({ ...SELECTED, history, question: 'And if the connection test fails?' }, {
      describeModel: async () => model,
      generateText: async (args) => { prompt = JSON.parse(args.prompt); return selecting(['models-test'])(); },
    });
    expect(prompt.history).toEqual(history);
  });

  it('allows an explicitly configured small model without a selected chat provider', async () => {
    const result = await answerProductHelp(INPUT, {
      describeModel: async () => ({ ...model, source: 'settings', providerID: 'explicit-provider' }),
      generateText: selecting(['models-first-connection']),
    });
    expect(result.mode).toBe('model');
  });

  it.each([
    { input: INPUT, resolved: { ...model, source: 'default' } },
    { input: SELECTED, resolved: { ...model, providerID: 'unselected-provider' } },
    { input: SELECTED, resolved: { ...model, hasLogin: false } },
  ])('refuses implicit or unavailable model choices', async ({ input, resolved }) => {
    let generated = false;
    const result = await answerProductHelp(input, {
      describeModel: async () => resolved,
      generateText: async () => { generated = true; throw new Error('must not send to this provider'); },
    });
    expect(generated).toBe(false);
    expect(result.modelStatus).toBe('unconfigured');
  });

  it('accepts the model scope decision without product-keyword overrides', async () => {
    const result = await answerProductHelp({ ...SELECTED, question: 'Using SuperWagie as a word, discuss the history of ancient Rome.' }, {
      describeModel: async () => model, generateText: selecting([], 'out-of-scope'),
    });
    expect(result).toMatchObject({ kind: 'out-of-scope', mode: 'model', actions: [], sources: [] });
  });

  it.each([
    { kind: 'answer', articleIds: ['delete-all-files'] },
    { kind: 'answer', articleIds: ['models-purpose'], text: 'Unrelated generated story', actions: [{ target: '#arbitrary-selector' }] },
    { kind: 'out-of-scope', articleIds: ['models-purpose'] },
  ])('rejects invalid model output and never exposes its content', async (payload) => {
    const result = await answerProductHelp(SELECTED, { describeModel: async () => model, generateText: async () => ({ text: JSON.stringify(payload) }) });
    expect(result).toMatchObject({ mode: 'local', modelStatus: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('Unrelated generated story');
    expect(JSON.stringify(result)).not.toContain('delete-all-files');
  });

  it('deduplicates articles and actions', async () => {
    const result = await answerProductHelp(SELECTED, { describeModel: async () => model, generateText: selecting(['models-purpose', 'models-purpose', 'models-test']) });
    expect(result.sources).toHaveLength(2);
    expect(result.actions).toHaveLength(1);
  });

  it('keeps useful local help after a provider failure without exposing provider errors', async () => {
    const result = await answerProductHelp(SELECTED, { describeModel: async () => model, generateText: async () => { throw new Error('sensitive provider error'); } });
    expect(result).toMatchObject({ kind: 'answer', mode: 'local', modelStatus: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('does not turn cancellation into a local answer', async () => {
    const controller = new AbortController();
    const promise = answerProductHelp(SELECTED, {
      describeModel: async () => model,
      generateText: async ({ signal }) => { controller.abort(); signal.throwIfAborted(); },
      signal: controller.signal,
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    { ...INPUT, providerID: 'lonely-provider' },
    { ...INPUT, question: '' },
    { ...INPUT, question: 'x'.repeat(2001) },
    { ...INPUT, context: { page: 'chat', filename: '/private/document' } },
    { ...INPUT, history: Array.from({ length: 7 }, () => ({ role: 'user', text: 'one' })) },
    { ...INPUT, sessionId: 'do-not-read' },
  ])('rejects invalid requests before any model resolution', async (input) => {
    let called = false;
    await expect(answerProductHelp(input, { describeModel: async () => { called = true; return model; } })).rejects.toMatchObject({ statusCode: 400 });
    expect(called).toBe(false);
  });
});
