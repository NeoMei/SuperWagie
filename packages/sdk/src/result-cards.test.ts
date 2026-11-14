import { describe, expect, test } from 'bun:test';
import { parseManifestJson } from './parse';
import { guestMessageSchema } from './protocol';

const panel = { id: 'cards', name: 'Cards', icon: 'file-text', entry: 'panel/index.html' };
type CardFixture = { title: string; script?: string; fields?: Array<{ label: string; value: string }>; link?: { label: string; url: string } };
type ToolFixture = { card?: CardFixture };
const parse = (tool: ToolFixture) => parseManifestJson(JSON.stringify({ apiVersion: 1, contributes: { panel, tools: [{ match: 'result', output: 'card', ...tool }] } }));
describe('passive result cards', () => {
  test('bounded output-only card declarations remain API version 1', () => {
    expect(parse({ card: { title: '{output.title}', fields: [{ label: 'File', value: '{output.path}' }], link: { label: 'View', url: '{output.url}' } } }).ok).toBe(true);
    for (const card of [
      { title: '{input.title}' }, { title: '{settings.key}' }, { title: '{output.title}', script: 'run()' },
      { title: '{output.title}', link: { label: 'Run', url: 'javascript:{output.url}' } },
      { title: '{output.title}', fields: Array.from({ length: 9 }, () => ({ label: 'File', value: '{output.path}' })) },
    ]) expect(parse({ card }).ok).toBe(false);
    expect(parse({}).ok).toBe(false);
  });
  test('host cards reject unknown controls and paths leaving their project', () => {
    const message = { channel: 'openchamber.sdk', v: 1, id: 'cards', type: 'result-cards', payload: { directory: '/project', cards: [{ title: 'Sample', version: 'v2', path: 'output/样稿.png' }] } };
    expect(guestMessageSchema.safeParse(message).success).toBe(true);
    for (const path of ['/private/file', '../file', 'a/../file', 'C:/file', '//server/share/file', 'a\\file']) {
      expect(guestMessageSchema.safeParse({ ...message, payload: { ...message.payload, cards: [{ title: 'File', path }] } }).success).toBe(false);
    }
    expect(guestMessageSchema.safeParse({ ...message, payload: { ...message.payload, cards: [{ title: 'File', onClick: 'send' }] } }).success).toBe(false);
  });
});
