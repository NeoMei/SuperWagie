import { PRODUCT_HELP_NAVIGATION_TARGETS } from '../packages/web/server/lib/product-help/navigation-targets.js';

/** Dependency-free preview checks. The publisher additionally uses the full runtime parser. */
export function projectProductHelpCatalogs(source) {
  if (source?.schemaVersion === 1) throw new Error('Product help author source must use schema 2');
  if (source?.schemaVersion !== 2
    || !Array.isArray(source.articles) || source.articles.length === 0
    || source.articles.some(article => article.target !== undefined && !PRODUCT_HELP_NAVIGATION_TARGETS.includes(article.target))) {
    throw new Error('Invalid product help content');
  }
  return [1, 2].map(schemaVersion => {
    // Pick public fields so author metadata cannot leak to either client format.
    const catalog = {
      schemaVersion, catalogVersion: source.catalogVersion, revision: source.revision, minAppVersion: source.minAppVersion,
      articles: source.articles.map(article => {
        const projected = { id: article.id, keywords: article.keywords ?? [],
          en: { title: article.en.title, text: article.en.text },
          'zh-CN': { title: article['zh-CN'].title, text: article['zh-CN'].text } };
        if (schemaVersion === 2 && article.target !== undefined) projected.target = article.target;
        return projected;
      }),
    };
    if (source.maxAppVersion !== undefined) catalog.maxAppVersion = source.maxAppVersion;
    return { version: `v${schemaVersion}`, bytes: Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`) };
  });
}
