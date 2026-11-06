import { describe, expect, it } from 'vitest';
import { BUNDLED_PRODUCT_HELP_CONTENT, getProductHelpContentVersion, parseProductHelpContent } from './content.js';

const update = () => ({
  schemaVersion: 1, catalogVersion: 'fixture.2', revision: 2, minAppVersion: '2.7.57',
  articles: [{ id: 'new-topic', keywords: ['new topic'], en: { title: 'New topic', text: 'Reviewed steps.' }, 'zh-CN': { title: '新主题', text: '已审核的步骤。' } }],
});

describe('product help content boundary', () => {
  it('merges an incremental content snapshot with the bundled baseline', () => {
    const result = parseProductHelpContent(update(), '2.7.57');
    expect(result.articles).toHaveLength(BUNDLED_PRODUCT_HELP_CONTENT.articles.length + 1);
    expect(result.articles.at(-1).id).toBe('new-topic');
    expect(Object.isFrozen(result.articles.at(-1).en)).toBe(true);
    expect(Object.isFrozen(result.articles.at(-1).keywords)).toBe(true);
    expect(Object.isFrozen(result.articles)).toBe(true);
  });

  it('replaces an existing article by id without duplication', () => {
    const content = update();
    content.articles[0].id = BUNDLED_PRODUCT_HELP_CONTENT.articles[0].id;
    const result = parseProductHelpContent(content, '2.7.57');
    expect(result.articles).toHaveLength(BUNDLED_PRODUCT_HELP_CONTENT.articles.length);
    expect(result.articles[0].en.text).toBe('Reviewed steps.');
  });

  it.each([1, 2])('rejects executable fields in schema %s', (schemaVersion) => {
    for (const field of ['actions', 'operations', 'match', 'selector', 'script', 'url']) {
      const content = { ...update(), schemaVersion };
      content.articles[0][field] = 'untrusted';
      expect(() => parseProductHelpContent(content, '2.7.57')).toThrow();
    }
  });

  it('accepts a registered navigation target for a newly published article', () => {
    const content = { ...update(), schemaVersion: 2 };
    content.articles[0].target = 'workbench';
    expect(parseProductHelpContent(content, '2.7.57').articles.at(-1).target).toBe('workbench');
  });

  it('inherits bundled navigation when normalizing schema 1 and preserves it across JSON round trips', () => {
    const content = update();
    content.articles[0].id = 'models-first-connection';
    const parsed = parseProductHelpContent(content, '2.7.57');
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.articles.find(article => article.id === 'models-first-connection').target).toBe('models');
    expect(parsed.articles.find(article => article.id === 'skills').target).toBe('skills');
    expect(parseProductHelpContent(JSON.parse(JSON.stringify(parsed)), '2.7.57')).toEqual(parsed);
  });

  it('rejects target fields in schema 1 instead of trusting a changed legacy contract', () => {
    const content = update();
    content.articles[0].target = 'workbench';
    expect(() => parseProductHelpContent(content, '2.7.57')).toThrow();
  });

  it.each(['unknown-control', '#arbitrary-selector', 'https://example.test/', null])('rejects unsupported navigation target %s', (target) => {
    const content = { ...update(), schemaVersion: 2 };
    content.articles[0].target = target;
    expect(() => parseProductHelpContent(content, '2.7.57')).toThrow();
  });

  it('removes a bundled navigation mapping when schema 2 omits its target', () => {
    const content = { ...update(), schemaVersion: 2 };
    content.articles[0].id = 'models-first-connection';
    const parsed = parseProductHelpContent(content, '2.7.57');
    expect(parsed.articles.find(article => article.id === 'models-first-connection').target).toBeUndefined();
    expect(parsed.articles.find(article => article.id === 'skills').target).toBe('skills');
    expect(parseProductHelpContent(JSON.parse(JSON.stringify(parsed)), '2.7.57')).toEqual(parsed);
  });

  it('changes the immutable content version when only navigation changes', () => {
    const content = { ...update(), schemaVersion: 2 };
    content.articles[0].target = 'workbench';
    const first = parseProductHelpContent(content, '2.7.57');
    content.articles[0].target = 'skills';
    const second = parseProductHelpContent(content, '2.7.57');
    expect(first.articles.at(-1).target).toBe('workbench');
    expect(getProductHelpContentVersion(first)).not.toBe(getProductHelpContentVersion(second));
  });

  it('rejects incompatible schemas and app ranges', () => {
    expect(() => parseProductHelpContent({ ...update(), schemaVersion: 3 }, '2.7.57')).toThrow();
    expect(() => parseProductHelpContent(update(), '2.7.56')).toThrow();
    expect(() => parseProductHelpContent({ ...update(), maxAppVersion: '2.7.58' }, '2.7.59')).toThrow();
    expect(() => parseProductHelpContent({ ...update(), maxAppVersion: '2.7.56' }, '2.7.57')).toThrow();
  });

  it('rejects duplicate ids, missing locales and oversized answers', () => {
    const content = update();
    expect(() => parseProductHelpContent({ ...content, articles: [...content.articles, ...content.articles] }, '2.7.57')).toThrow();
    delete content.articles[0]['zh-CN'];
    expect(() => parseProductHelpContent(content, '2.7.57')).toThrow();
    const oversized = update();
    oversized.articles[0].en.text = 'x'.repeat(6001);
    expect(() => parseProductHelpContent(oversized, '2.7.57')).toThrow();
  });

  it('bounds the merged article count and model prompt text', () => {
    const content = update();
    const article = content.articles[0];
    content.articles = Array.from({ length: 100 }, (_, index) => ({ ...article, id: `new-${index}` }));
    expect(() => parseProductHelpContent(content, '2.7.57')).toThrow();
    content.articles = Array.from({ length: 20 }, (_, index) => ({ ...article, id: `new-${index}`, en: { ...article.en, text: 'x'.repeat(6000) } }));
    expect(() => parseProductHelpContent(content, '2.7.57')).toThrow();
  });
});
