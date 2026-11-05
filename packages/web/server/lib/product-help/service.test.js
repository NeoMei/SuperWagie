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
    expect(prompt.articles.map(article => article.id)).toEqual(getProductHelpArticles('en').map(article => article.id));
    expect(prompt.articles.some(article => article.id === 'scheduled-tasks')).toBe(true);
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

  it.each([
    ['怎么在聊天里附加文件？', 'chat-input'],
    ['How do I attach a file to a message?', 'chat-input'],
    ['计划任务怎么创建？', 'scheduled-tasks'],
    ['How do I schedule a task?', 'scheduled-tasks'],
    ['定时任务模型连接失败怎么办？', 'scheduled-task-failure'],
    ['怎么让会话持续执行到目标完成？', 'session-goals'],
    ['怎么创建 worktree 隔离分支？', 'worktrees'],
    ['怎么处理权限询问和安全网？', 'permissions'],
    ['MCP 连接失败怎么办？', 'mcp'],
    ['How do I add an MCP server?', 'mcp'],
    ['怎么连接远程实例？', 'remote-instances'],
    ['怎么打开语音输入和朗读？', 'voice'],
    ['怎么搜索和恢复归档会话？', 'session-history'],
    ['How do I export a chat?', 'session-history'],
    ['怎么打开生成的文档预览？', 'files-preview'],
    ['怎么在终端运行命令？', 'terminal'],
    ['How do I stage and commit changes?', 'git-changes'],
    ['工作流面板在哪里启用？', 'workflows'],
    ['How do I enable workflows?', 'workflows'],
    ['聊天卡在等待回答，怎么提交选项？', 'chat-questions'],
    ['怎么停止生成和处理排队消息？', 'chat-stop-queue'],
    ['上下文满了怎么压缩？', 'context-compact'],
    ['怎么查看和删除记忆？', 'memory'],
    ['怎么检查更新？', 'updates'],
    ['怎么在聊天上传文件？', 'chat-input'],
    ['How do I use the Git workflow?', 'git-changes'],
    ['How do I use Git worktrees?', 'worktrees'],
    ['怎么配置语音模型？', 'voice'],
    ['How do I open an external tunnel?', 'external-tunnel'],
    ['终端连接失败怎么办？', 'terminal'],
    ['How do I fix terminal connection failure?', 'terminal'],
    ['怎么上传文件到聊天？', 'chat-input'],
    ['How do I upload a file to chat?', 'chat-input'],
    ['如何在资料库里搜索文件？', 'knowledge-search'],
    ['How do I search files?', 'files-preview'],
    ['How do I search for a file?', 'files-preview'],
    ['计划任务不执行怎么办？', 'scheduled-task-failure'],
    ['计划任务没有触发怎么办？', 'scheduled-task-failure'],
    ['My scheduled task does not run', 'scheduled-task-failure'],
    ['My scheduled task doesn’t run', 'scheduled-task-failure'],
    ['How do I enable memory?', 'memory'],
    ['How do I enable voice input?', 'voice'],
  ])('finds specific operation help without a model: %s', async (question, id) => {
    const result = await answerProductHelp({ ...INPUT, question }, offline);
    expect(result.kind).toBe('answer');
    expect(result.sources[0]?.id).toBe(id);
  });

  it('keeps operation follow-ups specific after the original question leaves history', async () => {
    const previous = await answerProductHelp({ ...INPUT, question: '怎么创建定时任务？' }, offline);
    const result = await answerProductHelp({ ...INPUT, question: '失败了怎么办？', history: [
      { role: 'assistant', text: previous.text },
    ] }, offline);
    expect(result.sources[0]?.id).toBe('scheduled-task-failure');
  });

  it.each(['How do I push a baby stroller?', 'How do I improve my memory?', 'How do I warm up my voice?'])('does not confuse common words with product operations: %s', async (question) => {
    const result = await answerProductHelp({ ...INPUT, question }, offline);
    expect(result).toMatchObject({ kind: 'out-of-scope', actions: [], sources: [] });
  });

  it.each([
    ['settings:mcp', 'mcp'], ['settings:voice', 'voice'],
    ['settings:remote-instances', 'remote-instances'], ['settings:about', 'updates'],
    ['settings:skills.catalog', 'skills'], ['settings:extensions', 'plugins-extensions'],
    ['settings:sessions', 'session-history'], ['settings:chat', 'chat-input'],
  ])('explains the current settings page without a model: %s', async (page, id) => {
    const result = await answerProductHelp({ ...INPUT, question: '这个页面怎么用？', context: { page } }, offline);
    expect(result.sources[0]?.id).toBe(id);
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
