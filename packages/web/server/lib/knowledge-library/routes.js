/**
 * HTTP surface for the knowledge library.
 *
 * Routes here only validate input, call the runtime and map its error codes to
 * status codes. They never touch the backend directly, and they never echo a
 * credential: the runtime's status carries booleans, not values.
 *
 * `express.json()` is mounted in this module because the server has no global
 * JSON parser for `/api` paths outside its allowlist.
 */

import express from 'express';
import path from 'node:path';
import { z } from 'zod';

const addLibrarySchema = z.object({ path: z.string().trim().min(1) });
const updateLibrarySchema = z.object({ enabled: z.boolean() });
const searchSchema = z.object({
  query: z.string().trim().min(1),
  libraryId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const provisionSchema = z.object({ modelApiKey: z.string().trim().min(1) });

const STATUS_BY_ERROR = {
  not_found: 404,
  already_added: 409,
  path_not_absolute: 400,
  path_missing: 400,
  path_not_directory: 400,
  path_unreadable: 400,
  not_indexed: 409,
  not_provisioned: 503,
  backend_unavailable: 503,
};

const CONTENT_TYPES = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

const errorCodeSchema = z.object({ code: z.string() });

const sendError = (res, error, fallbackStatus = 400) => {
  const text = z.string().safeParse(error);
  const object = errorCodeSchema.safeParse(error);
  const code = text.success ? text.data : object.success ? object.data.code : 'request_failed';
  res.status(STATUS_BY_ERROR[code] ?? fallbackStatus).json({ error: code });
};

export const registerKnowledgeLibraryRoutes = (app, { runtime }) => {
  if (!runtime) return;

  const json = express.json({ limit: '64kb' });

  const guarded = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      // ProvisionError carries a granular code (`not_provisioned`,
      // `provision_*`); the class name is what says "the backend is not set up
      // yet", so the code alone cannot be compared.
      if (error?.name === 'ProvisionError') {
        return res.status(503).json({ error: error.code ?? 'not_provisioned' });
      }
      if (error?.code === 'not_provisioned') {
        return res.status(503).json({ error: 'not_provisioned' });
      }
      res.status(500).json({ error: 'internal_error' });
    }
  };

  app.get('/api/knowledge-library/status', guarded(async (req, res) => {
    res.json(await runtime.getStatus({ includeModelConfiguration: req.query.models === '1' }));
  }));

  app.get('/api/knowledge-library/libraries', guarded(async (_req, res) => {
    res.json({ libraries: await runtime.readLibraries() });
  }));

  app.post('/api/knowledge-library/libraries/preview', json, guarded(async (req, res) => {
    const parsed = addLibrarySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'path_required');
    const result = await runtime.previewLibrary(parsed.data.path);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.post('/api/knowledge-library/rescan', guarded(async (_req, res) => {
    const result = await runtime.rescan();
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.post('/api/knowledge-library/libraries', json, guarded(async (req, res) => {
    const parsed = addLibrarySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'path_required');
    const result = await runtime.addLibrary(parsed.data.path);
    if (result?.error) return sendError(res, result.error);
    res.status(201).json(result);
  }));

  app.patch('/api/knowledge-library/libraries/:id', json, guarded(async (req, res) => {
    const parsed = updateLibrarySchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'enabled_required');
    const result = await runtime.setLibraryEnabled(req.params.id, parsed.data.enabled);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.delete('/api/knowledge-library/libraries/:id', guarded(async (req, res) => {
    const deleteRemote = req.query.deleteRemote === 'true';
    const result = await runtime.removeLibrary(req.params.id, { deleteRemote });
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.post('/api/knowledge-library/libraries/:id/rescan', guarded(async (req, res) => {
    const result = await runtime.rescan(req.params.id);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/documents', guarded(async (req, res) => {
    res.json(
      await runtime.listDocuments({
        libraryId: z.string().optional().safeParse(req.query.libraryId).data,
        state: z.string().optional().safeParse(req.query.state).data,
        limit: Number(req.query.limit) || undefined,
        offset: Number(req.query.offset) || undefined,
      }),
    );
  }));

  app.delete('/api/knowledge-library/documents/:id', guarded(async (req, res) => {
    const result = await runtime.removeDocument(req.params.id);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.post('/api/knowledge-library/documents/:id/retry', guarded(async (req, res) => {
    const result = await runtime.retryDocument(req.params.id);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.post('/api/knowledge-library/documents/retry-failed', guarded(async (_req, res) => {
    res.json(await runtime.retryFailed());
  }));

  app.post('/api/knowledge-library/clean-missing', guarded(async (_req, res) => {
    res.json(await runtime.cleanMissing());
  }));

  app.post('/api/knowledge-library/search', json, guarded(async (req, res) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'query_required');
    const result = await runtime.search(parsed.data);
    if (result?.error) return sendError(res, result.error, 503);
    res.json(result);
  }));

  app.get('/api/knowledge-library/images', guarded(async (req, res) => {
    const page = Number.parseInt(String(req.query.page ?? '1'), 10);
    const pageSize = Number.parseInt(String(req.query.pageSize ?? '24'), 10);
    const result = await runtime.listImages({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 60) : 24,
    });
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/images/content', guarded(async (req, res) => {
    const result = await runtime.readImage(String(req.query.url ?? ''));
    if (result?.error) return sendError(res, result.error);
    res.setHeader('Content-Type', result.contentType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    result.stream.pipe(res);
  }));

  app.get('/api/knowledge-library/wiki/pages', guarded(async (req, res) => {
    const page = Number.parseInt(String(req.query.page ?? '1'), 10);
    const pageSize = Number.parseInt(String(req.query.pageSize ?? '200'), 10);
    const result = await runtime.listWikiPages({
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 2000) : 200,
    });
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/wiki/page', guarded(async (req, res) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug) return sendError(res, 'not_found');
    const result = await runtime.readWikiPage(slug);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/wiki/folders', guarded(async (_req, res) => {
    const result = await runtime.listWikiFolders();
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/wiki/page', guarded(async (req, res) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug) return sendError(res, 'not_found');
    const result = await runtime.readWikiPage(slug);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/wiki/graph', guarded(async (_req, res) => {
    const result = await runtime.readWikiGraph();
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/documents/:id/content', guarded(async (req, res) => {
    const result = await runtime.readContent(req.params.id);
    if (result?.error) return sendError(res, result.error);
    res.json(result);
  }));

  app.get('/api/knowledge-library/documents/:id/file', guarded(async (req, res) => {
    const result = await runtime.getFile(req.params.id);
    if (result?.error) return sendError(res, result.error);
    const extension = path.extname(result.fileName ?? '').slice(1).toLowerCase();
    res.setHeader('Content-Type', result.contentType ?? CONTENT_TYPES[extension] ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=utf-8''${encodeURIComponent(result.fileName ?? 'file')}`);
    result.stream.pipe(res);
  }));

  app.post('/api/knowledge-library/provision', json, guarded(async (req, res) => {
    const parsed = provisionSchema.safeParse(req.body);
    if (!parsed.success) return sendError(res, 'model_key_required');
    const result = await runtime.provision(parsed.data.modelApiKey);
    if (result?.error) return sendError(res, result.error, 502);
    res.json(result);
  }));

  app.post('/api/knowledge-library/reconnect', guarded(async (_req, res) => {
    res.json(await runtime.reconnect());
  }));

  app.post('/api/knowledge-library/rebuild', guarded(async (_req, res) => {
    res.json(await runtime.rebuild());
  }));
};
