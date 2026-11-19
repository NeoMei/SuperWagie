import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PRODUCT_OCR_MODEL } from './ocr-contract.js';
import { createProductOcrReader } from './product-ocr-reader.js';

it('lets the bundled parser read only the matching pre-settled PDF while the initiating actor remains current', async () => {
  const source = Buffer.from('%PDF-1.7\nfixture');
  const original = 'swocr_' + 'b'.repeat(60);
  const document = { id: 'pc_fixture', pages: [{ index: 0, text: '识别结果', layout: [] }] };
  let now = Date.now();
  let current = true;
  const reader = createProductOcrReader({ available: () => true, now: () => now });
  try {
    const opened = await reader.open({ original, document, fileName: 'original.pdf', bytes: source.length,
      sourceHash: createHash('sha256').update(source).digest('hex'), assertCurrent: async () => { if (!current) throw new Error('auth changed'); },
    });
    const { paddleocr_vl_cloud_token: token, paddleocr_vl_cloud_base_url: jobs } = opened.processConfig.parser_engine_overrides;
    const send = (bytes, fileName, auth = token) => {
      const body = new FormData();
      body.set('file', new Blob([bytes], { type: 'application/pdf' }), fileName);
      body.set('model', PRODUCT_OCR_MODEL);
      body.set('optionalPayload', '{}');
      return fetch(jobs, { method: 'POST', headers: { Authorization: `bearer ${auth}` }, body });
    };
    expect((await fetch(new URL(`/ocr-document/${opened.id}`, jobs))).status).toBe(403);
    expect((await send(source, 'original.pdf', 'x'.repeat(43))).status).toBe(403);
    expect((await send(source, 'different.pdf')).status).toBe(403);
    expect((await send(Buffer.from('%PDF-1.7\nchanged'), 'original.pdf')).status).toBe(403);
    expect((await send(Buffer.from('%PDF-1.7\nfixturE'), 'original.pdf')).status).toBe(403);
    const submit = await send(source, 'original.pdf');
    expect(submit.status).toBe(200);
    expect((await submit.json()).data.jobId).toBe(opened.id);
    const status = await fetch(`${jobs}/${opened.id}`, { headers: { Authorization: `bearer ${token}` } });
    const { data } = await status.json();
    expect(data.state).toBe('done');
    const result = await fetch(data.resultUrl.jsonUrl);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await result.json()).result.layoutParsingResults[0].markdown.text).toBe('识别结果');
    current = false;
    expect(await reader.has(original)).toBe(false);
    expect((await fetch(data.resultUrl.jsonUrl)).status).toBe(403);
    current = true;
    const retry = await reader.open({ original, document, fileName: 'original.pdf', bytes: source.length,
      sourceHash: createHash('sha256').update(source).digest('hex'), assertCurrent: async () => {},
    });
    expect(retry.id).not.toBe(opened.id);
    now += 6 * 60 * 1000;
    expect(await reader.has(original)).toBe(false);
  } finally {
    await reader.close();
  }
});
