import { describe, expect, it } from 'vitest';
import { BUNDLED_PRODUCT_HELP_CONTENT, parseProductHelpContent } from './content.js';

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

  it.each(['actions', 'match', 'script', 'url'])('rejects remote capability field %s', (field) => {
    const content = update();
    content.articles[0][field] = 'untrusted';
    expect(() => parseProductHelpContent(content, '2.7.57')).toThrow();
  });

  it('rejects incompatible schemas and app ranges', () => {
    expect(() => parseProductHelpContent({ ...update(), schemaVersion: 2 }, '2.7.57')).toThrow();
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
