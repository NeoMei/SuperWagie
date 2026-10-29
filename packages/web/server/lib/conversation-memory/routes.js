import express from 'express';
import { z } from 'zod';

const directorySchema = z.string().trim().min(1).max(8192);
const sourceSchema = z.object({ sessionId: z.string().min(1).max(1024), directory: directorySchema }).strict();
const entrySchema = z.object({ id: z.string().min(1).max(200), directory: directorySchema }).strict();
const listSchema = z.object({ directory: directorySchema, query: z.string().max(32_000).optional() }).strict();

// Registered after normal UI auth and before the OpenCode proxy. Bodies are
// parsed per route so unrelated proxy requests retain their input stream.
export const registerConversationMemoryRoutes = (app, { runtime }) => {
  const json = express.json({ limit: '64kb' });
  const run = (work) => async (req, res) => {
    try { return res.json(await work(req)); }
    catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: 'invalid_request', code: 'invalid_request' });
      const code = /^[a-z][a-z0-9_:-]{0,79}$/.test(error?.code ?? '') ? error.code : 'conversation_memory_unavailable';
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      return res.status(status).json({ error: code, code });
    }
  };
  app.get('/api/conversation-memory/status', run(() => runtime.status()));
  app.put('/api/conversation-memory/settings', json, run((req) => runtime.setEnabled(z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled)));
  app.get('/api/conversation-memory/entries', run((req) => runtime.listEntries(listSchema.parse(req.query))));
  app.post('/api/conversation-memory/capture', json, run((req) => runtime.capture(sourceSchema.parse(req.body))));
  app.post('/api/conversation-memory/retry', json, run((req) => runtime.retry(entrySchema.parse(req.body))));
  app.post('/api/conversation-memory/consolidate', json, run((req) => runtime.consolidate(z.object({ directory: directorySchema, entryIds: z.array(z.string().min(1).max(200)).min(2).max(10) }).strict().parse(req.body))));
  app.post('/api/conversation-memory/entries/:id/confirm', run((req) => runtime.confirm({ id: req.params.id, ...z.object({ directory: directorySchema }).strict().parse(req.query) })));
  app.delete('/api/conversation-memory/entries/:id', run((req) => runtime.forget({ id: req.params.id, ...z.object({ directory: directorySchema }).strict().parse(req.query) })));
};
