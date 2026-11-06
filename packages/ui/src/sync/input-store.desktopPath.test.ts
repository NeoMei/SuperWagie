import { afterAll, expect, mock, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { attachmentBasename, attachmentWireName } from '@/lib/attachmentIdentity';

mock.module('heic2any', () => ({
  default: async () => new Blob(['jpeg-data'], { type: 'image/jpeg' }),
}));

/**
 * A dropped file's on-disk path reaches the attachment, so the model is handed
 * the file's location instead of a bare basename. This lives in its own file:
 * it installs the desktop globals the intake gate reads, which would leak into
 * the store's other cases if they shared a process.
 */

// The store installs its `onload` as a closure over the reader, never as a
// `this`-bound handler, so the stub only needs the no-argument shape.
class ImmediateFileReader {
  result: string | ArrayBuffer | null = 'data:text/plain;base64,aGVsbG8=';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;
  readAsDataURL(file: File) {
    void file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}

const origin = 'http://127.0.0.1:3901';
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousFileReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    location: { origin, href: `${origin}/` },
    dispatchEvent: () => true,
    __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
    __OPENCHAMBER_LOCAL_ORIGIN__: origin,
    __OPENCHAMBER_API_BASE_URL__: origin,
    __OPENCHAMBER_DESKTOP__: {
      invoke: async () => null,
      // Stands in for Electron's `webUtils.getPathForFile`.
      pathForFile: (file: File) => `/Users/me/Documents/${file.name}`,
    },
  },
});
Object.defineProperty(globalThis, 'FileReader', { configurable: true, writable: true, value: ImmediateFileReader });

afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (previousFileReader) Object.defineProperty(globalThis, 'FileReader', previousFileReader);
  else Reflect.deleteProperty(globalThis, 'FileReader');
});

test('a desktop-dropped file carries its on-disk path while the chip label stays the basename', async () => {
  const { useInputStore } = await import('./input-store');

  const attached = await useInputStore.getState().addAttachedFile(
    new File(['hello'], 'report.txt', { type: 'text/plain' }),
  );

  expect(attached).toBe(true);
  const [file] = useInputStore.getState().attachedFiles;
  expect(file?.filename).toBe('report.txt');
  expect(file?.agentPath).toBe('/Users/me/Documents/report.txt');
  expect(file?.dataUrl).toBe('data:text/plain;base64,aGVsbG8=');
});

for (const [wireName, basename] of [
  ['/Users/me/Documents/report.txt', 'report.txt'],
  ['C:\\Users\\me\\report.txt', 'report.txt'],
  ['/Users/me/Documents/photo.heic', 'photo.heic'],
  ['weird\\name.txt', 'weird\\name.txt'],
  ['report.txt', 'report.txt'],
]) {
  test(`restoring ${wireName} keeps its citation name and resend identity`, async () => {
    const { useInputStore } = await import('./input-store');
    const { findAttachmentCitationRanges } = await import('@/components/chat/attachmentCitations');
    const store = useInputStore.getState();
    store.clearAttachedFiles();
    store.addRestoredAttachment({ url: 'data:text/plain;base64,aGVsbG8=', mimeType: 'text/plain', filename: wireName });

    const [restored] = useInputStore.getState().attachedFiles;
    expect(restored.filename).toBe(basename);
    expect(restored.file?.name).toBe(basename);
    expect(attachmentWireName(restored)).toBe(wireName);
    expect(findAttachmentCitationRanges(`[${basename}]`, [restored.filename])).toHaveLength(1);
  });
}

test('a content-transformed attachment does not carry the path to the unsanitized original', async () => {
  const { useInputStore } = await import('./input-store');
  useInputStore.getState().clearAttachedFiles();

  const har = JSON.stringify({ log: { entries: [{ request: { headers: [{ name: 'authorization', value: 'Bearer secret' }] } }] } });
  const attached = await useInputStore.getState().addAttachedFile(
    new File([har], 'capture.har', { type: 'application/json' }),
  );

  expect(attached).toBe(true);
  const [file] = useInputStore.getState().attachedFiles;
  expect(file?.filename).toBe('capture.har');
  expect(file?.agentPath).toBeUndefined();
  expect(await file?.file?.text()).not.toContain('Bearer secret');
});

test('only the extracted document text carries the original path', async () => {
  const { prepareLocalAttachments } = await import('./input-store');
  const file = new File([zipSync({
    'word/document.xml': strToU8('<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p><w:p><a:blip r:embed="image"/></w:p></w:body></w:document>'),
    'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship Id="image" Target="media/chart.png" Type="image"/></Relationships>'),
    'word/media/chart.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  })], 'report.docx');

  const attached = await prepareLocalAttachments(file);

  expect(attached).toHaveLength(2);
  expect(attached?.[0]?.agentPath).toBe('/Users/me/Documents/report.docx');
  expect(await attached?.[0]?.file?.text()).toContain('[report-image-1.png]');
  expect(attached?.[1]?.filename).toBe('report-image-1.png');
  expect(attached?.[1]?.agentPath).toBeUndefined();
});

test('notebooks with omitted outputs do not carry the original path', async () => {
  const { prepareLocalAttachments } = await import('./input-store');
  const notebook = { cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [
    { data: { 'image/png': 'binary-output' } },
  ] }] };
  const attached = await prepareLocalAttachments(new File([JSON.stringify(notebook)], 'analysis.IPYNB'));

  expect(attached).toHaveLength(1);
  expect(attached?.[0]?.agentPath).toBeUndefined();
  expect(await attached?.[0]?.file?.text()).not.toContain('binary-output');
});

for (const extension of ['heic', 'heif']) {
  test(`converted ${extension} keeps the original path and matching citation name`, async () => {
    const { prepareLocalAttachments } = await import('./input-store');
    const attached = await prepareLocalAttachments(new File(['heic-data'], `photo.${extension}`, { type: `image/${extension}` }));
    const file = attached?.[0];

    expect(file).toBeDefined();
    expect(file?.mimeType).toBe('image/jpeg');
    expect(await file?.file?.text()).toBe('jpeg-data');
    expect(file?.agentPath).toBe(`/Users/me/Documents/photo.${extension}`);
    expect(file?.filename).toBe(`photo.${extension}`);
    if (file) expect(attachmentBasename(attachmentWireName(file))).toBe(file.filename);
  });
}

for (const [name, bytes] of [
  ['dump.log', 15 * 1024 * 1024],
  ['季度 报告.pdf', 25 * 1024 * 1024],
] as const) {
  test(`large desktop ${name} carries only its path and size note`, async () => {
    const { useInputStore } = await import('./input-store');
    const store = useInputStore.getState();
    store.clearAttachedFiles();
    expect(await store.addAttachedFile(new File([new Uint8Array(bytes)], name))).toBe(true);
    const [file] = useInputStore.getState().attachedFiles;
    expect(file?.source).toBe('local');
    expect(file?.size).toBe(bytes);
    expect(file?.filename).toBe(name);
    expect(file?.agentPath).toBe(`/Users/me/Documents/${name}`);
    expect(file?.serverPath).toBe(file?.agentPath);
    expect(file?.dataUrl.startsWith('data:text/plain;')).toBe(true);
    expect(file?.dataUrl.length).toBeLessThan(1024);
    expect(await file?.file.text()).toContain(`/Users/me/Documents/${name}`);
    expect(await file?.file.text()).toContain(bytes === 15728640 ? '15' : '25');
  });
}

for (const name of ['capture.har', 'analysis.IPYNB']) {
  test(`large ${name} never exposes its unsanitized original through a path`, async () => {
    const { useInputStore } = await import('./input-store');
    const store = useInputStore.getState();
    store.clearAttachedFiles();
    await expect(store.addAttachedFile(new File([new Uint8Array(15 * 1024 * 1024)], name))).rejects.toThrow(name);
    expect(useInputStore.getState().attachedFiles).toEqual([]);
  });
}

for (const action of ['clear', 'switch'] as const) {
  test(`${action} during reference preparation cancels the result`, async () => {
    const { useInputStore } = await import('./input-store');
    const store = useInputStore.getState();
    store.clearAttachedFiles();
    const adding = store.addAttachedFile(new File([new Uint8Array(15 * 1024 * 1024)], 'dump.log'));
    if (action === 'clear') store.clearAttachedFiles();
    else store.selectAttachmentDraft({ runtimeKey: 'local', directory: '/repo', sessionId: 'switched' });
    expect(await adding).toBe(false);
    expect(useInputStore.getState().attachedFiles).toEqual([]);
    store.selectAttachmentDraft(null);
  });
}

test('large reference survives history and draft selection and can be removed', async () => {
  const { useInputStore } = await import('./input-store');
  const { createInputHistorySubmission } = await import('@/stores/useInputHistoryStore');
  const { mapInputHistoryEntriesToValues } = await import('@/components/chat/inputHistory');
  const store = useInputStore.getState();
  const draft = { runtimeKey: 'desktop', directory: '/repo', sessionId: 'reference' };
  store.selectAttachmentDraft(draft);
  store.clearAttachedFiles();
  await store.addAttachedFile(new File([new Uint8Array(15 * 1024 * 1024)], 'dump.log'));
  const [original] = useInputStore.getState().attachedFiles;
  const submission = createInputHistorySubmission('inspect', [original]);
  const serialized = JSON.parse(JSON.stringify({ ...submission, submittedAt: 1 }));
  const [restored] = mapInputHistoryEntriesToValues([serialized])[0].attachments;
  expect(restored?.dataUrl).toBe(original.dataUrl);
  expect(restored?.agentPath).toBe(original.agentPath);
  expect(restored?.serverPath).toBe(original.serverPath);
  store.selectAttachmentDraft({ ...draft, sessionId: 'other' });
  expect(useInputStore.getState().attachedFiles).toEqual([]);
  store.selectAttachmentDraft(draft);
  expect(useInputStore.getState().attachedFiles).toEqual([original]);
  store.removeAttachedFile(original.id);
  expect(useInputStore.getState().attachedFiles).toEqual([]);
  store.selectAttachmentDraft(null);
});

test('outgoing prompt and queued assembly send bounded notes, including restored history', async () => {
  const { useInputStore } = await import('./input-store');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { configureRuntimeUrlResolver } = await import('@/lib/runtime-url');
  const { buildOutgoingMessage } = await import('@/components/chat/composer/submit/buildOutgoingMessage');
  const { createInputHistorySubmission } = await import('@/stores/useInputHistoryStore');
  const { mapInputHistoryEntriesToValues } = await import('@/components/chat/inputHistory');
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  configureRuntimeUrlResolver({ apiBaseUrl: origin });
  const directory = opencodeClient.getDirectory();
  opencodeClient.setDirectory('/repo');
  const recordingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toBe('/api/session/reference-test/prompt');
    bodies.push(await request.text());
    return Response.json({ data: { id: 'message' } });
  };
  globalThis.fetch = recordingFetch;
  try {
    const store = useInputStore.getState();
    store.clearAttachedFiles();
    for (const [name, bytes] of [['dump.log', 15 * 1024 * 1024], ['季度 报告.pdf', 25 * 1024 * 1024]] as const) {
      store.clearAttachedFiles();
      await store.addAttachedFile(new File([new Uint8Array(bytes)], name));
      const [original] = useInputStore.getState().attachedFiles;
      const entry = { ...createInputHistorySubmission('inspect', [original]), submittedAt: 1 };
      const restored = mapInputHistoryEntriesToValues([entry])[0].attachments;
      const outgoing = buildOutgoingMessage({
        queued: [{ text: 'queued', attachments: [...restored] }],
        composerText: 'inspect', composerAttachments: [],
        inlineComments: [], syntheticTexts: [], references: [],
      }, {
        parseAgentMention: (text) => ({ text }),
        extractFileMentions: (text) => ({ text, attachments: [] }),
        sanitizeAttachments: (files) => [...(files ?? [])],
        collectSkillNames: () => [],
      });
      for (const attachments of [[original], outgoing.primaryAttachments]) {
        await opencodeClient.sendMessage({
          id: 'reference-test', providerID: 'provider', text: 'inspect', directory: '/repo',
          files: attachments.map((file) => ({ type: 'file', mime: file.mimeType, filename: attachmentWireName(file), url: file.dataUrl })),
        });
      }
    }
    for (const [index, body] of bodies.entries()) {
      expect(Buffer.byteLength(body)).toBeLessThan(1024);
      expect(body).not.toContain('file://');
      const parsed = z.object({ files: z.array(z.object({ uri: z.string(), name: z.string() })) }).parse(JSON.parse(body));
      expect(parsed.files).toHaveLength(1);
      const name = index < 2 ? 'dump.log' : '季度 报告.pdf';
      expect(parsed.files[0]?.name).toBe(`/Users/me/Documents/${name}`);
      const note = Buffer.from(parsed.files[0].uri.split(',')[1], 'base64').toString();
      expect(note).toContain(`/Users/me/Documents/${name}`);
      expect(note).toContain(index < 2 ? '15' : '25');
    }
    expect(bodies).toHaveLength(4);
  } finally {
    globalThis.fetch = originalFetch;
    opencodeClient.setDirectory(directory);
  }
});

test('unsupported local desktop binary falls back to a note without reading its bytes into the prompt', async () => {
  const { useInputStore } = await import('./input-store');
  const store = useInputStore.getState();
  store.clearAttachedFiles();
  expect(await store.addAttachedFile(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], 'book.epub'))).toBe(true);
  const [file] = useInputStore.getState().attachedFiles;
  expect(file.dataUrl.startsWith('data:text/plain;')).toBe(true);
  expect(await file.file.text()).toContain('/Users/me/Documents/book.epub');
});

test('a desktop connected to a remote runtime refuses a large local file', async () => {
  const { useInputStore } = await import('./input-store');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const store = useInputStore.getState();
  store.clearAttachedFiles();
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example/api', runtimeKey: 'remote-example' });
    await expect(store.addAttachedFile(new File([new Uint8Array(15 * 1024 * 1024)], 'dump.log'))).rejects.toThrow('dump.log');
    expect(useInputStore.getState().attachedFiles).toEqual([]);
  } finally {
    switchRuntimeEndpoint({ apiBaseUrl: origin, runtimeKey: 'local' });
  }
});

for (const [name, content] of [['capture.har', '{"log":{"entries":[]}}'], ['analysis.ipynb', '{"cells":[]}']] as const) {
  test(`oversized sensitive @ source ${name} is refused before sanitization`, async () => {
    const { prepareLocalAttachments } = await import('./input-store');
    const file = new File([content, ' '.repeat(10 * 1024 * 1024)], name);
    expect(await prepareLocalAttachments(file)).toBeUndefined();
  });
}

for (const extension of ['log', 'docx']) {
  test(`fork replay of a bounded ${extension} note keeps resend and history identity`, async () => {
    const { useInputStore } = await import('./input-store');
    const { isMentionAlreadyAttached } = await import('@/components/chat/composer/attachments/inlineMentionAttachments');
    const { createInputHistorySubmission } = await import('@/stores/useInputHistoryStore');
    const { mapInputHistoryEntriesToValues } = await import('@/components/chat/inputHistory');
    const store = useInputStore.getState();
    store.clearAttachedFiles();
    const filename = extension === 'log' ? '季度 large.log' : 'large.docx';
    await store.addAttachedFile(new File([new Uint8Array(15 * 1024 * 1024)], filename));
    const [original] = useInputStore.getState().attachedFiles;
    store.clearAttachedFiles();
    store.addRestoredAttachment({ url: original.dataUrl, mimeType: original.mimeType, filename: attachmentWireName(original) });
    const [replay] = useInputStore.getState().attachedFiles;
    const mention = { serverPath: attachmentWireName(original), filename: original.filename };
    expect(isMentionAlreadyAttached(mention, [replay])).toBe(true);
    expect(replay.serverPath).toBe(original.agentPath);
    const submission = createInputHistorySubmission('inspect', [replay]);
    expect(submission.restorableAttachments).toHaveLength(1);
    const [history] = mapInputHistoryEntriesToValues([{ ...submission, submittedAt: 1 }])[0].attachments;
    expect(history.dataUrl).toBe(original.dataUrl);
    expect(isMentionAlreadyAttached(mention, [history])).toBe(true);
    expect(history.dataUrl.length).toBeLessThan(1024);
  });
}

test('fork restoration does not grant note identity to ordinary inline content or sensitive originals', async () => {
  const { useInputStore } = await import('./input-store');
  const { createInputHistorySubmission } = await import('@/stores/useInputHistoryStore');
  const store = useInputStore.getState();
  for (const name of ['capture.har', 'analysis.ipynb', 'ordinary.log']) {
    const path = `/Users/me/Documents/${name}`;
    const text = name === 'ordinary.log' ? 'ordinary inline content' : `File on disk: ${path} (15 MB). Its content is not in this message.\n`;
    const url = `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
    store.clearAttachedFiles();
    store.addRestoredAttachment({ url, mimeType: 'text/plain', filename: path });
    const [restored] = useInputStore.getState().attachedFiles;
    expect(restored.serverPath).toBe(url);
    if (name !== 'ordinary.log') expect(restored.agentPath).toBeUndefined();
    expect(createInputHistorySubmission('inspect', [restored]).restorableAttachments).toEqual([]);
  }
});

test('fork restoration rejects mismatched, malformed and oversized note identities', async () => {
  const { useInputStore } = await import('./input-store');
  const { createInputHistorySubmission } = await import('@/stores/useInputHistoryStore');
  const store = useInputStore.getState();
  const path = '/Users/me/Documents/large.log';
  const note = `File on disk: ${path} (15 MB). Its content is not in this message.\n`;
  const encode = (text: string) => `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
  for (const [url, mimeType] of [
    [encode('File on disk: /other/large.log (15 MB).'), 'text/plain'],
    [encode(note + 'x'.repeat(40_000)), 'text/plain'],
    ['data:text/plain;base64,!!!', 'text/plain'],
    [encode(note), 'application/pdf'],
  ]) {
    store.clearAttachedFiles();
    store.addRestoredAttachment({ url, mimeType, filename: path });
    const [restored] = useInputStore.getState().attachedFiles;
    expect(restored.serverPath).toBe(url);
    expect(createInputHistorySubmission('inspect', [restored]).restorableAttachments).toEqual([]);
  }
});
