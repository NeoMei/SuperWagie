import express from 'express';
import { z } from 'zod';
import { PRODUCT_HELP_CATALOG_VERSION, getProductHelpArticles } from './catalog.js';
import { answerProductHelp as answerWithBundledHelp, productHelpRequestSchema } from './service.js';

const localeSchema = z.enum(['en', 'zh-CN']).default('en');

export function registerProductHelpRoutes(app, { getDefaultDirectory, answerProductHelp = answerWithBundledHelp } = {}) {
  app.get('/api/product-help/articles', (req, res) => {
    const locale = localeSchema.safeParse(req.query.locale);
    if (!locale.success) return res.status(400).json({ code: 'product_help_invalid_request', error: 'Invalid help language' });
    res.json({ catalogVersion: PRODUCT_HELP_CATALOG_VERSION, articles: getProductHelpArticles(locale.data) });
  });

  app.post('/api/product-help/answer', express.json({ limit: '128kb' }), async (req, res) => {
    const parsed = productHelpRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'product_help_invalid_request', error: 'Invalid product help request' });
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try {
      const directory = parsed.data.directory ?? getDefaultDirectory?.();
      const input = { ...parsed.data };
      if (directory) input.directory = directory;
      const answer = await answerProductHelp(input, { signal: controller.signal });
      if (!res.destroyed && !res.writableEnded) res.json(answer);
    } catch {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
        res.status(503).json({ code: 'product_help_unavailable', error: 'Product help is temporarily unavailable' });
      }
    } finally {
      res.off('close', cancel);
    }
  });
}
