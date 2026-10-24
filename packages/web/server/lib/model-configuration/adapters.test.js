import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { testModelBinding } from './adapters.js';

describe('model protocol probes', () => {
  it('sends vision probes with a valid PNG at a usable image size', async () => {
    const requests = [];
    await testModelBinding({
      purpose: 'vision', protocol: 'openai-compatible', model: 'fixture-vision',
      baseUrl: 'https://provider.example/v1', apiKey: 'fixture-key', parameters: {},
    }, {
      fetchImpl: async (url, init) => {
        requests.push({ url, payload: JSON.parse(init.body) });
        return Response.json({ choices: [{ message: { content: 'A blue square.' } }] });
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://provider.example/v1/chat/completions');
    expect(requests[0].payload.max_tokens).toBe(64);
    const imageUrl = requests[0].payload.messages[0].content.find((part) => part.type === 'image_url').image_url.url;
    expect(imageUrl).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(imageUrl.split(',')[1], 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const chunks = [];
    for (let offset = 8; offset < png.length;) {
      expect(offset + 12).toBeLessThanOrEqual(png.length);
      const length = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      const end = offset + 8 + length;
      expect(end + 4).toBeLessThanOrEqual(png.length);
      expect(png.readUInt32BE(end), `${type} CRC`).toBe(crc32(png.subarray(offset + 4, end)));
      chunks.push({ type, data: png.subarray(offset + 8, end) });
      offset = end + 4;
    }
    expect(chunks[0].type).toBe('IHDR');
    expect(chunks.at(-1)).toEqual({ type: 'IEND', data: Buffer.alloc(0) });
    const header = chunks[0].data;
    expect(header).toHaveLength(13);
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    expect(width).toBeGreaterThanOrEqual(64);
    expect(height).toBeGreaterThanOrEqual(64);
    expect([...header.subarray(10)]).toEqual([0, 0, 0]);
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header[9]];
    expect(channels).toBeDefined();
    const rowBytes = Math.ceil(width * header[8] * channels / 8);
    const pixels = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
    expect(pixels).toHaveLength(height * (rowBytes + 1));
    for (let row = 0; row < height; row += 1) {
      expect(pixels[row * (rowBytes + 1)]).toBeLessThanOrEqual(4);
    }
  });
});
