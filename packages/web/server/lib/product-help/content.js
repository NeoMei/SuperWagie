import { z } from 'zod';
import { createHash } from 'node:crypto';
import bundled from './content.json' with { type: 'json' };
import webPackage from '../../../package.json' with { type: 'json' };
import { PRODUCT_HELP_NAVIGATION_TARGETS } from './navigation-targets.js';

export const CURRENT_PRODUCT_HELP_APP_VERSION = webPackage.version;
export const MAX_PRODUCT_HELP_CONTENT_BYTES = 512_000;

const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/);
const localized = z.object({
  title: z.string().trim().min(1).max(300),
  // Three selected articles, including their titles, fit the answer limit.
  text: z.string().trim().min(1).max(6_000),
}).strict();
const articleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  keywords: z.array(z.string().trim().min(2).max(80)).max(16).default([]),
  en: localized,
  'zh-CN': localized,
}).strict();
const legacyContentSchema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  minAppVersion: version,
  maxAppVersion: version.optional(),
  articles: z.array(articleSchema).min(1).max(100),
}).strict();
const contentSchema = z.discriminatedUnion('schemaVersion', [
  legacyContentSchema,
  legacyContentSchema.extend({
    schemaVersion: z.literal(2),
    articles: z.array(articleSchema.extend({ target: z.enum(PRODUCT_HELP_NAVIGATION_TARGETS).optional() })).min(1).max(100),
  }),
]);

const compareVersions = (left, right) => {
  const a = version.parse(left).split('.').map(Number);
  const b = version.parse(right).split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

const freezeContent = (content) => {
  for (const article of content.articles) {
    Object.freeze(article.en);
    Object.freeze(article['zh-CN']);
    Object.freeze(article.keywords);
    Object.freeze(article);
  }
  Object.freeze(content.articles);
  return Object.freeze(content);
};

const baseline = contentSchema.parse(bundled);

export function parseProductHelpContent(value, appVersion = CURRENT_PRODUCT_HELP_APP_VERSION) {
  const content = contentSchema.parse(value);
  if (compareVersions(appVersion, content.minAppVersion) < 0
    || (content.maxAppVersion && (compareVersions(appVersion, content.maxAppVersion) > 0
      || compareVersions(content.minAppVersion, content.maxAppVersion) > 0))) {
    throw new Error('Product help content is incompatible with this app version');
  }
  const ids = new Set(content.articles.map(article => article.id));
  if (ids.size !== content.articles.length) throw new Error('Duplicate product help article id');
  // Each publication contains the cumulative edits and additions. Omitted
  // shipped articles retain their offline instructions, regardless of cache history.
  const articles = new Map(baseline.articles.map(article => [article.id, article]));
  for (const article of content.articles) {
    // Legacy publications have no mapping field; keep the bundled destination.
    // Schema 2 owns the mapping, so omitting target explicitly removes navigation.
    const target = content.schemaVersion === 1 ? articles.get(article.id)?.target : article.target;
    articles.set(article.id, target ? { ...article, target } : article);
  }
  const merged = { ...content, schemaVersion: 2, articles: [...articles.values()] };
  if (merged.articles.length > 100) throw new Error('Too many product help articles');
  for (const locale of ['en', 'zh-CN']) {
    const length = merged.articles.reduce((sum, article) => sum + article[locale].title.length + article[locale].text.length, 0);
    if (length > 60_000) throw new Error('Product help text exceeds the model context budget');
  }
  if (Buffer.byteLength(JSON.stringify(merged)) > MAX_PRODUCT_HELP_CONTENT_BYTES) {
    throw new Error('Product help content exceeds the size limit');
  }
  return freezeContent(merged);
}

export const BUNDLED_PRODUCT_HELP_CONTENT = parseProductHelpContent(bundled);

export const getProductHelpContentVersion = content => `${content.catalogVersion}@${content.revision}:${createHash('sha256').update(JSON.stringify(content.articles)).digest('hex')}`;
