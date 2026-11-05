import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BUNDLED_PRODUCT_HELP_CONTENT,
  CURRENT_PRODUCT_HELP_APP_VERSION,
  MAX_PRODUCT_HELP_CONTENT_BYTES,
  parseProductHelpContent,
} from './content.js';

const OFFICIAL_SOURCE_URL = 'https://www.superwagie.com/product-help/v1/catalog.json';
const MAX_CACHE_BYTES = MAX_PRODUCT_HELP_CONTENT_BYTES + 16_384;
const etagSchema = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const cacheSchema = z.strictObject({
  sourceUrl: z.string(),
  etag: etagSchema.optional(),
  content: z.json(),
});

const validateSourceUrl = (sourceUrl) => {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.includes('?') || url.href.includes('#')) return null;
    return url.href;
  } catch {
    return null;
  }
};

const defaultCacheFile = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'product-help',
  'content-cache.json',
);

const isNewer = (candidate, current) => candidate.revision > current.revision
  && candidate.catalogVersion !== current.catalogVersion;

const isSameContent = (candidate, current) => candidate.revision === current.revision
  && candidate.catalogVersion === current.catalogVersion
  && JSON.stringify(candidate) === JSON.stringify(current);

const readCache = async (cacheFile, sourceUrl, appVersion) => {
  let handle;
  try {
    handle = await fs.open(cacheFile, 'r');
    const buffer = Buffer.alloc(MAX_CACHE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CACHE_BYTES) return null;
    const cached = cacheSchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    if (cached.sourceUrl !== sourceUrl) return null;
    return { content: parseProductHelpContent(cached.content, appVersion), etag: cached.etag };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const writeCache = async (cacheFile, record) => {
  const temporaryFile = `${cacheFile}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporaryFile, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporaryFile, cacheFile);
  } catch {
    // The verified in-memory snapshot remains usable when persistence fails.
  } finally {
    await fs.unlink(temporaryFile).catch(() => {});
  }
};

const readResponseContent = async (response, signal) => {
  const advertisedBytes = Number(response.headers.get('content-length'));
  if (advertisedBytes > MAX_PRODUCT_HELP_CONTENT_BYTES || signal.aborted) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Product help content is unavailable');
  }
  if (!response.body) throw new Error('Product help content is empty');

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_PRODUCT_HELP_CONTENT_BYTES) throw new Error('Product help content is too large');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
};

const downloadContent = async ({ sourceUrl, etag, fetchImpl, timeoutMs, appVersion }) => {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('Product help download timed out'));
    }, timeoutMs);
  });
  const download = async () => {
    const headers = { Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetchImpl(sourceUrl, {
      method: 'GET', headers, credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    if (response.redirected || (response.url && response.url !== sourceUrl)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Product help redirects are not allowed');
    }
    if (response.status === 304) return null;
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Product help download failed');
    }
    const content = parseProductHelpContent(await readResponseContent(response, controller.signal), appVersion);
    const parsedEtag = etagSchema.safeParse(response.headers.get('etag'));
    return { content, etag: parsedEtag.success ? parsedEtag.data : undefined };
  };
  try {
    return await Promise.race([download(), deadline]);
  } finally {
    clearTimeout(timeout);
  }
};

/** Request-driven updates; a failed check retains the last compatible snapshot. */
export const createProductHelpContentStore = ({
  sourceUrl = process.env.OPENCHAMBER_PRODUCT_HELP_URL?.trim() || OFFICIAL_SOURCE_URL,
  cacheFile = defaultCacheFile(),
  fetchImpl = fetch,
  now = Date.now,
  appVersion = CURRENT_PRODUCT_HELP_APP_VERSION,
  refreshIntervalMs = 300_000,
  timeoutMs = 4_000,
} = {}) => {
  const source = validateSourceUrl(sourceUrl);
  let snapshot = BUNDLED_PRODUCT_HELP_CONTENT;
  let etag;
  let cacheInitialization;
  let nextRefreshAt = -Infinity;
  let pendingRefresh = null;

  const initializeCache = async () => {
    if (!source) return;
    const cached = await readCache(cacheFile, source, appVersion);
    if (cached && isNewer(cached.content, snapshot)) {
      snapshot = cached.content;
      etag = cached.etag;
    } else if (cached && isSameContent(cached.content, snapshot)) {
      etag = cached.etag;
    }
  };

  const refreshContent = async () => {
    if (!source || process.env.OPENCHAMBER_PRODUCT_HELP_UPDATES === '0' || now() < nextRefreshAt) return snapshot;
    try {
      const candidate = await downloadContent({ sourceUrl: source, etag, fetchImpl, timeoutMs, appVersion });
      if (candidate && isNewer(candidate.content, snapshot)) {
        await writeCache(cacheFile, { sourceUrl: source, ...candidate });
        snapshot = candidate.content;
        etag = candidate.etag;
      } else if (candidate && candidate.etag !== etag && isSameContent(candidate.content, snapshot)) {
        await writeCache(cacheFile, { sourceUrl: source, content: snapshot, etag: candidate.etag });
        etag = candidate.etag;
      }
    } catch {
      // Network, format and compatibility failures never replace reviewed help.
    } finally {
      nextRefreshAt = now() + refreshIntervalMs;
    }
    return snapshot;
  };

  return {
    getSnapshot: async ({ refresh = true } = {}) => {
      cacheInitialization ??= initializeCache();
      await cacheInitialization;
      if (!refresh) return snapshot;
      if (!pendingRefresh) pendingRefresh = refreshContent().finally(() => { pendingRefresh = null; });
      return pendingRefresh;
    },
  };
};

let defaultStore;

export const getProductHelpContent = (options) => {
  defaultStore ??= createProductHelpContentStore();
  return defaultStore.getSnapshot(options);
};
