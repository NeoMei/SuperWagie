import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

// Local folders indexed by the embedded knowledge backend
// (packages/web/server/lib/knowledge-library). The server owns the backend and
// the ledger; this module only asks for status and sends the four commands the
// settings page offers.

const backendStateSchema = z.enum([
  'not-installed',
  'stopped',
  'starting',
  'running',
  'unavailable',
  'port-conflict',
]);

const librarySchema = z.object({
  id: z.string(),
  root: z.string(),
  name: z.string(),
  slug: z.string(),
  enabled: z.boolean().optional(),
  lastScanAt: z.number().nullable().optional(),
});

const documentStateSchema = z.enum(['pending', 'queued', 'parsing', 'ready', 'failed', 'skipped', 'missing']);

const documentSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  relPath: z.string(),
  absPath: z.string(),
  size: z.number(),
  state: documentStateSchema,
  parseStatus: z.string().nullable().optional(),
  lastError: z.object({ code: z.string(), message: z.string().optional() }).nullable().optional(),
});

const searchDocumentSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  path: z.string(),
  relPath: z.string(),
  libraryId: z.string(),
  fileType: z.string(),
  size: z.number(),
  parseStatus: z.string(),
  matched: z.string(),
});

const passageSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  path: z.string(),
  relPath: z.string(),
  libraryId: z.string(),
  content: z.string(),
  score: z.number(),
  chunkIndex: z.number(),
  startAt: z.number(),
  endAt: z.number(),
});

const searchResultSchema = z.object({
  query: z.string(),
  documents: z.array(searchDocumentSchema),
  passages: z.array(passageSchema),
});

const statsSchema = z.object({
  libraries: z.number(),
  files: z.number(),
  indexable: z.number(),
  skipped: z.number(),
});

const modelPurposeSchema = z.enum(['embedding', 'rerank', 'vision', 'ocr']);
const modelConfigurationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    models: z.array(z.object({
      purpose: modelPurposeSchema,
      modelId: z.string(),
      model: z.string(),
      baseUrl: z.string(),
      dimensions: z.number().optional(),
      hasKey: z.boolean(),
    })),
    unavailablePurposes: z.array(modelPurposeSchema).optional(),
  }),
  z.object({
    status: z.literal('unavailable'),
    reason: z.enum(['backend_unavailable', 'account_unavailable', 'backend_not_ready']),
  }),
]);

const statusSchema = z.object({
  modelConfiguration: modelConfigurationSchema.optional(),
  supported: z.boolean(),
  enabled: z.boolean(),
  provisioned: z.boolean(),
  backend: z.object({
    state: backendStateSchema,
    port: z.number(),
    error: z.string().nullable().optional(),
    logPath: z.string().nullable().optional(),
  }),
  error: z.string().nullable().optional(),
  stats: statsSchema.optional(),
  indexing: z.object({
    queued: z.number(),
    parsing: z.number(),
    ready: z.number(),
    failed: z.number(),
    skipped: z.number(),
    missing: z.number(),
  }).optional(),
});

export type KnowledgeLibraryLibrary = z.infer<typeof librarySchema>;
export type KnowledgeLibraryDocument = z.infer<typeof documentSchema>;
export type KnowledgeLibrarySearchResult = z.infer<typeof searchResultSchema>;
export type KnowledgeLibraryModelConfiguration = z.infer<typeof modelConfigurationSchema>;
export type KnowledgeLibraryStatus = z.infer<typeof statusSchema>;

/** The server's stable error code, so the page can name the failure. */
export class KnowledgeLibraryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'KnowledgeLibraryError';
    this.code = code;
  }
}

const errorBodySchema = z.object({ error: z.string() });

const errorCodeOf = async (response: Response): Promise<string> => {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    /* not JSON */
  }
  return `http_${response.status}`;
};

const readStatus = (response: Response): Promise<KnowledgeLibraryStatus> => {
  if (!response.ok) throw new KnowledgeLibraryError(`http_${response.status}`);
  return Promise.resolve(response.json()).then((body) => {
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) throw new KnowledgeLibraryError('bad_response');
    return parsed.data;
  });
};

export const readKnowledgeLibraryStatus = async (signal?: AbortSignal): Promise<KnowledgeLibraryStatus> => {
  const response = await runtimeFetch('/api/knowledge-library/status', { signal });
  return readStatus(response);
};

export const readKnowledgeLibraryModelConfiguration = async (signal?: AbortSignal): Promise<KnowledgeLibraryModelConfiguration> => {
  const response = await runtimeFetch('/api/knowledge-library/status?models=1', { signal });
  const status = await readStatus(response);
  if (!status.modelConfiguration) throw new KnowledgeLibraryError('bad_response');
  return status.modelConfiguration;
};

const post = async (path: string, body?: { modelApiKey: string }): Promise<void> => {
  const init: RequestInit = { method: 'POST' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await runtimeFetch(path, init);
  if (!response.ok) throw new KnowledgeLibraryError(await errorCodeOf(response));
};

export const provisionKnowledgeLibrary = (modelApiKey: string): Promise<void> =>
  post('/api/knowledge-library/provision', { modelApiKey });

export const reconnectKnowledgeLibrary = (): Promise<void> => post('/api/knowledge-library/reconnect');

export const rebuildKnowledgeLibraryIndex = (): Promise<void> => post('/api/knowledge-library/rebuild');


const getJson = async <T,>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
  const response = await runtimeFetch(path, { signal });
  if (!response.ok) throw new KnowledgeLibraryError(`http_${response.status}`);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new KnowledgeLibraryError('bad_response');
  return parsed.data;
};

export const listKnowledgeLibraries = async (signal?: AbortSignal): Promise<KnowledgeLibraryLibrary[]> => {
  const body = await getJson('/api/knowledge-library/libraries', z.object({ libraries: z.array(librarySchema) }), signal);
  return body.libraries;
};

export const listKnowledgeDocuments = async (
  { libraryId, signal }: { libraryId?: string; signal?: AbortSignal } = {},
): Promise<KnowledgeLibraryDocument[]> => {
  const params = new URLSearchParams({ limit: '5000' });
  if (libraryId) params.set('libraryId', libraryId);
  const query = `?${params.toString()}`;
  const body = await getJson(
    `/api/knowledge-library/documents${query}`,
    z.object({ total: z.number(), documents: z.array(documentSchema) }),
    signal,
  );
  return body.documents;
};

type SearchPayload = { query: string; libraryId?: string };

export const searchKnowledgeLibrary = async (
  { query, libraryId, signal }: { query: string; libraryId?: string; signal?: AbortSignal },
): Promise<KnowledgeLibrarySearchResult> => {
  const payload: SearchPayload = { query };
  if (libraryId) payload.libraryId = libraryId;
  const response = await runtimeFetch('/api/knowledge-library/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw new KnowledgeLibraryError(await errorCodeOf(response));
  const parsed = searchResultSchema.safeParse(await response.json());
  if (!parsed.success) throw new KnowledgeLibraryError('bad_response');
  return parsed.data;
};

const previewEstimateSchema = z.object({
  tokensMin: z.number().nonnegative(),
  tokensMax: z.number().nonnegative(),
  secondsMin: z.number().nonnegative(),
  secondsMax: z.number().nonnegative(),
  imageHeavyFiles: z.number().int().nonnegative(),
});

export type KnowledgeLibraryPreview = {
  total: number;
  indexable: number;
  skipped: number;
  estimate?: z.infer<typeof previewEstimateSchema>;
};

export const previewKnowledgeLibrary = async (path: string): Promise<KnowledgeLibraryPreview> => {
  const response = await runtimeFetch('/api/knowledge-library/libraries/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw new KnowledgeLibraryError(await errorCodeOf(response));
  const parsed = z.object({ total: z.number(), indexable: z.number(), skipped: z.number(), estimate: previewEstimateSchema.optional() })
    .safeParse(await response.json());
  if (!parsed.success) throw new KnowledgeLibraryError('bad_response');
  return parsed.data;
};

export const addKnowledgeLibrary = async (path: string): Promise<KnowledgeLibraryLibrary> => {
  const response = await runtimeFetch('/api/knowledge-library/libraries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw new KnowledgeLibraryError(await errorCodeOf(response));
  const parsed = z.object({ library: librarySchema }).safeParse(await response.json());
  if (!parsed.success) throw new KnowledgeLibraryError('bad_response');
  return parsed.data.library;
};

export const removeKnowledgeLibrary = async (id: string, { deleteRemote = false } = {}): Promise<void> => {
  const response = await runtimeFetch(
    `/api/knowledge-library/libraries/${encodeURIComponent(id)}?deleteRemote=${deleteRemote ? 'true' : 'false'}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new KnowledgeLibraryError(await errorCodeOf(response));
};

export const removeKnowledgeDocument = async (id: string): Promise<void> => {
  const response = await runtimeFetch(`/api/knowledge-library/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new KnowledgeLibraryError(await errorCodeOf(response));
};

export const setKnowledgeLibraryWatching = async (id: string, enabled: boolean): Promise<void> => {
  const response = await runtimeFetch(`/api/knowledge-library/libraries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new KnowledgeLibraryError(await errorCodeOf(response));
};

export const rescanKnowledgeLibrary = (id: string): Promise<void> =>
  post(`/api/knowledge-library/libraries/${encodeURIComponent(id)}/rescan`);


// ── wiki and gallery ────────────────────────────────────────────────────────

const imageSchema = z.object({
  id: z.string(),
  source: z.object({
    documentId: z.string(),
    path: z.string(),
    relPath: z.string(),
  }).nullable().default(null),
  sourceName: z.string(),
  caption: z.string(),
  url: z.string(),
});

const imagesSchema = z.object({ images: z.array(imageSchema), total: z.number() });

export type KnowledgeLibraryImage = z.infer<typeof imageSchema>;

export const listKnowledgeImages = async (signal?: AbortSignal): Promise<KnowledgeLibraryImage[]> => {
  const body = await getJson('/api/knowledge-library/images?pageSize=24', imagesSchema, signal);
  return body.images;
};

/** Image bytes need the server's tenant session, so they travel as a blob URL. */
export const loadKnowledgeImage = async (url: string, signal?: AbortSignal): Promise<string> => {
  const response = await runtimeFetch(
    `/api/knowledge-library/images/content?url=${encodeURIComponent(url)}`,
    { signal },
  );
  if (!response.ok) throw new KnowledgeLibraryError(`http_${response.status}`);
  return URL.createObjectURL(await response.blob());
};

const wikiPageSchema = z.object({
  slug: z.string(),
  title: z.string(),
  pageType: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  folderId: z.string().optional(),
  categoryPath: z.array(z.string()).optional(),
  updatedAt: z.string(),
});

const wikiPagesSchema = z.object({
  enabled: z.boolean(),
  pages: z.array(wikiPageSchema),
  total: z.number(),
});

export type KnowledgeLibraryWikiPages = z.infer<typeof wikiPagesSchema>;

export const readKnowledgeWikiPages = (signal?: AbortSignal): Promise<KnowledgeLibraryWikiPages> =>
  getJson('/api/knowledge-library/wiki/pages?pageSize=2000', wikiPagesSchema, signal);

const wikiFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  parentId: z.string(),
  pageCount: z.number(),
});

const wikiFoldersSchema = z.object({
  enabled: z.boolean(),
  folders: z.array(wikiFolderSchema),
});

export type KnowledgeLibraryWikiFolders = z.infer<typeof wikiFoldersSchema>;

export const readKnowledgeWikiFolders = (signal?: AbortSignal): Promise<KnowledgeLibraryWikiFolders> =>
  getJson('/api/knowledge-library/wiki/folders', wikiFoldersSchema, signal);

const wikiGraphSchema = z.object({
  enabled: z.boolean(),
  nodes: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      page_type: z.string().optional(),
      link_count: z.number().optional(),
    }),
  ),
  edges: z.array(z.object({ source: z.string(), target: z.string() })),
});

export type KnowledgeLibraryWikiGraph = z.infer<typeof wikiGraphSchema>;

export const readKnowledgeWikiGraph = (signal?: AbortSignal): Promise<KnowledgeLibraryWikiGraph> =>
  getJson('/api/knowledge-library/wiki/graph', wikiGraphSchema, signal);
