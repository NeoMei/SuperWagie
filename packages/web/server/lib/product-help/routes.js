import express from 'express';
import { z } from 'zod';
import { getProductHelpArticles } from './catalog.js';
import { getProductHelpContent } from './content-store.js';
import { getProductHelpContentVersion } from './content.js';
import { answerProductHelp as answerWithProductHelp, productHelpRequestSchema } from './service.js';

const localeSchema = z.enum(['en', 'zh-CN']).default('en');

export function registerProductHelpRoutes(app, { getDefaultDirectory, answerProductHelp = answerWithProductHelp, getContent = getProductHelpContent } = {}) {
  app.get('/api/product-help/articles', async (req, res) => {
    const locale = localeSchema.safeParse(req.query.locale);
    if (!locale.success) return res.status(400).json({ code: 'product_help_invalid_request', error: 'Invalid help language' });
    try {
      const content = await getContent();
      res.set('Cache-Control', 'no-store').json({ catalogVersion: getProductHelpContentVersion(content), articles: getProductHelpArticles(locale.data, content) });
    } catch {
      res.status(503).json({ code: 'product_help_unavailable', error: 'Product help is temporarily unavailable' });
    }
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
      const content = await getContent({ refresh: false });
      controller.signal.throwIfAborted();
      const answer = await answerProductHelp(input, { signal: controller.signal, content });
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
