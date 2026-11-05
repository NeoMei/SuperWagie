import { describe, expect, it } from 'vitest';
import { getProductHelpArticles, selectLocalProductHelp } from './catalog.js';
import { answerProductHelp } from './service.js';

const makeContent = () => ({
  catalogVersion: 'fixture.2',
  revision: 2,
  articles: getProductHelpArticles('en').map((article, index) => ({
    id: article.id, keywords: [],
    en: { title: article.title, text: article.text },
    'zh-CN': getProductHelpArticles('zh-CN')[index],
  })),
});
const newArticle = {
  id: 'workspace-notes', keywords: ['workspace notes', '工作区便笺'],
  en: { title: 'Workspace notes', text: 'Open the workspace notes panel.' },
  'zh-CN': { title: '工作区便笺', text: '打开工作区便笺面板。' },
};

describe('independently updated product help', () => {
  it('uses updated text while retaining shipped actions', async () => {
    const content = makeContent();
    content.articles.find(article => article.id === 'models-first-connection').en.text = 'Updated connection instructions.';
    const result = await answerProductHelp({ question: 'How do I connect the first model?' }, { content });
    expect(result.catalogVersion).toMatch(/^fixture\.2@2:[a-f0-9]{64}$/);
    expect(result.text).toContain('Updated connection instructions.');
    expect(result.actions.map(action => action.id)).toEqual(['models-locate', 'models-guide']);
  });

  it('finds newly published articles locally without adding actions', async () => {
    const content = makeContent();
    content.articles.push(newArticle);
    const result = await answerProductHelp({ question: '如何使用工作区便笺？', locale: 'zh-CN' }, { content });
    expect(result.sources).toEqual([{ id: newArticle.id, title: newArticle['zh-CN'].title }]);
    expect(result.actions).toEqual([]);
    expect(result.text).toContain(newArticle['zh-CN'].text);
  });

  it('uses one content snapshot for model selection and answer rendering', async () => {
    const content = makeContent();
    content.articles.push(newArticle);
    const result = await answerProductHelp({ question: 'How do workspace notes work?', directory: '/project' }, {
      content,
      describeModel: async () => ({ source: 'settings', providerID: 'configured', modelID: 'small', hasLogin: true }),
      generateText: async ({ prompt, responseSchema }) => {
        expect(JSON.parse(prompt).articles.at(-1).id).toBe(newArticle.id);
        expect(responseSchema.properties.articleIds.items.enum).toContain(newArticle.id);
        return { text: JSON.stringify({ kind: 'answer', articleIds: [newArticle.id] }) };
      },
    });
    expect(result.mode).toBe('model');
    expect(result.catalogVersion).toMatch(/^fixture\.2@2:[a-f0-9]{64}$/);
    expect(result.text).toContain(newArticle.en.text);
  });

  it('matches English keywords as words and prefers the longest matching phrase', () => {
    const content = makeContent();
    content.articles.push({ ...newArticle, id: 'ai-settings', keywords: ['AI'] });
    content.articles.push({ ...newArticle, keywords: ['AI workspace notes'] });
    const select = question => selectLocalProductHelp(question, { page: '' }, [], content);
    expect(select('Why did my scheduled task fail?').articleIds).toEqual(['scheduled-task-failure']);
    expect(select('How do I change my email?').articleIds).not.toContain('ai-settings');
    expect(select('How do I use AI workspace notes?').articleIds).toEqual(['workspace-notes']);
    expect(select('如何使用AI？').articleIds).toEqual(['ai-settings']);
  });

  it('distinguishes reused release labels by their increasing revision', async () => {
    const content = makeContent();
    const first = await answerProductHelp({ question: 'How do I connect the first model?' }, { content });
    content.revision = 4;
    const later = await answerProductHelp({ question: 'How do I connect the first model?' }, { content });
    expect(first.catalogVersion).not.toBe(later.catalogVersion);
  });

  it('distinguishes merged baseline changes under the same feed revision', async () => {
    const content = makeContent();
    const first = await answerProductHelp({ question: 'How do I connect the first model?' }, { content });
    content.articles.find(article => article.id === 'models-first-connection').en.text = 'Instructions from an updated backend baseline.';
    const later = await answerProductHelp({ question: 'How do I connect the first model?' }, { content });
    expect(first.catalogVersion).not.toBe(later.catalogVersion);
  });
});
