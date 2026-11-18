import crypto from 'node:crypto';
import http from 'node:http';
import { paddleDocumentResult, PRODUCT_OCR_MAX_FILE_BYTES, PRODUCT_OCR_MODEL } from './ocr-contract.js';

const jobsPath = '/api/v2/ocr/jobs';
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const expiresAfter = 5 * 60 * 1000;
const limit = 32;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function respond(res, status, value, type = 'application/json') {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}

/** Returns only pre-settled parser results to the bundled worker. */
export function createProductOcrReader({ now = Date.now, available }) {
  const jobs = new Map();
  const tokens = new Map();
  let server;
  let origin;
  let opening;
  const expire = () => {
    for (const [id, job] of jobs) {
      if (job.expiresAt <= now()) { tokens.delete(job.token); jobs.delete(id); }
    }
  };
  const active = async (job) => {
    if (!available() || !job || job.expiresAt <= now()) throw new Error('OCR result not authorized');
    await job.assertCurrent();
  };
  const handle = async (req, res) => {
    expire();
    if (req.headers.host !== new URL(origin).host || req.headersDistinct?.host?.length !== 1 || req.headers.origin || req.url.includes('?')) throw new Error('OCR reader request is invalid');
    if (req.method === 'GET' && req.url.startsWith('/ocr-document/')) {
      const id = req.url.slice('/ocr-document/'.length);
      const job = keyPattern.test(id) ? jobs.get(id) : null;
      await active(job);
      if (!job.requested) throw new Error('OCR result not opened by parser');
      return respond(res, 200, job.data, 'application/x-ndjson');
    }

    const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token || req.headersDistinct?.authorization?.length !== 1) throw new Error('OCR reader token is invalid');
    const id = tokens.get(token);
    const job = jobs.get(id);
    await active(job);
    if (req.method === 'POST' && req.url === jobsPath) {
      const contentType = req.headers['content-type'];
      if (!contentType?.startsWith('multipart/form-data;')) throw new Error('OCR reader input is invalid');
      const chunks = [];
      let length = 0;
      for await (const part of req) {
        length += part.length;
        if (length > PRODUCT_OCR_MAX_FILE_BYTES + 256 * 1024) throw new Error('OCR reader input is too large');
        chunks.push(part);
      }
      const body = Buffer.concat(chunks);
      const fields = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
      const file = fields.get('file');
      if ([...fields.keys()].sort().join(',') !== 'file,model,optionalPayload' || fields.get('model') !== PRODUCT_OCR_MODEL
        || !(file instanceof File) || file.name !== job.fileName || file.size !== job.bytes
        || hash(Buffer.from(await file.arrayBuffer())) !== job.sourceHash) throw new Error('OCR reader source changed');
      await active(job);
      job.requested = true;
      return respond(res, 200, { errorCode: 0, errorMsg: '', data: { jobId: id } });
    }
    if (req.method !== 'GET' || req.url !== `${jobsPath}/${id}` || !job.requested) throw new Error('OCR reader job is invalid');
    return respond(res, 200, { errorCode: 0, errorMsg: '', data: {
      jobId: id, state: 'done', extractProgress: { totalPages: job.pages, extractedPages: job.pages }, resultUrl: { jsonUrl: `${origin}/ocr-document/${id}` },
    } });
  };
  const listen = async () => {
    if (origin) return;
    opening ??= new Promise((resolve, reject) => {
      server = http.createServer((req, res) => { void handle(req, res).catch(() => respond(res, 403, { errorCode: 403 })); });
      server.requestTimeout = 20_000;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
    await opening;
  };
  return {
    has: async (original) => {
      expire();
      for (const [id, job] of jobs) {
        if (job.original !== original) continue;
        try { await active(job); return true; }
        catch { tokens.delete(job.token); jobs.delete(id); }
      }
      return false;
    },
    open: async ({ original, document, fileName, sourceHash, bytes, assertCurrent }) => {
      await assertCurrent();
      expire();
      if (!available() || jobs.size >= limit) throw new Error('OCR reader unavailable');
      await listen();
      await assertCurrent();
      const id = crypto.randomBytes(32).toString('base64url');
      const token = crypto.randomBytes(32).toString('base64url');
      jobs.set(id, { original, fileName, sourceHash, bytes, assertCurrent, token, data: paddleDocumentResult(document),
        pages: document.pages.length, expiresAt: now() + expiresAfter });
      tokens.set(token, id);
      return { id, processConfig: {
        parser_engine_rules: [{ file_types: ['pdf'], engine: 'paddleocr_vl_cloud' }],
        parser_engine_overrides: { paddleocr_vl_cloud_base_url: `${origin}${jobsPath}`, paddleocr_vl_cloud_token: token, paddleocr_vl_cloud_model: PRODUCT_OCR_MODEL },
      } };
    },
    closeJob: (id) => { const job = jobs.get(id); if (job) tokens.delete(job.token); jobs.delete(id); },
    close: async () => {
      jobs.clear();
      tokens.clear();
      await opening?.catch(() => {});
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
