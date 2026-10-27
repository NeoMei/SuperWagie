import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import sharp from 'sharp';

import * as generator from './generate.mjs';
import { PIXEL_CUBES, encodeIco, pixelCube } from './raster.mjs';

test('every retained OpenChamber text file matches scripts/brand', () => {
  const stale = [...generator.textOutputs()]
    .filter(([path, text]) => !existsSync(path) || readFileSync(path, 'utf8') !== text)
    .map(([path]) => relative(process.cwd(), path));
  expect(stale).toEqual([]);
});

test('brand generation leaves SuperWagie web and Electron assets with their owner', async () => {
  const paths = [...generator.textOutputs().keys(), ...(await generator.imageOutputs()).keys()]
    .map((path) => relative(process.cwd(), path));
  expect(paths.filter((path) => path.startsWith('packages/web/public/') || path.startsWith('packages/electron/'))).toEqual([]);
  expect(paths).not.toContain('packages/web/index.html');
  expect(paths).toContain('packages/vscode/src/webviewHtml.ts');
  expect(paths).toContain('packages/web/server/lib/opencode/static-routes-runtime.js');
  expect(paths).toContain('packages/mobile/assets/icon-only.png');
});

test('SuperWagie product and wordmark PNGs decode with visible pixels', async () => {
  for (const path of [
    'packages/web/public/logo.png',
    'packages/web/public/superwagie-logo.png',
    'packages/web/public/superwagie-logo-dark.png',
    'packages/electron/resources/icons/icon.png',
    'packages/electron/resources/icons/app-icon.png',
  ]) {
    const image = sharp(readFileSync(path));
    const metadata = await image.metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.width).toBe(metadata.height);
    const { channels } = await image.ensureAlpha().stats();
    expect(channels[3].max).toBeGreaterThan(0);
    expect(channels.slice(0, 3).some(({ min, max }) => min !== max)).toBe(true);
  }
});

test('fork SVG wrappers and the early splash contain decodable PNG artwork', async () => {
  for (const path of [
    'packages/electron/resources/icons/icon-win.svg',
    'packages/electron/resources/icons/app-icon.svg',
    'packages/electron/resources/icons/dev-icon-win.svg',
    'packages/electron/resources/icons/tray/tray-glyph.svg',
    'packages/web/public/favicon.svg',
    'packages/web/public/apple-touch-icon.svg',
    'packages/web/public/logo-dark-512x512.svg',
    'packages/web/public/logo-light-512x512.svg',
    'packages/electron/early-startup.mjs',
  ]) {
    const embedded = [...readFileSync(path, 'utf8').matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
    expect(embedded.length).toBe(path.endsWith('.mjs') ? 2 : 1);
    for (const [, base64] of embedded) {
      const { info } = await sharp(Buffer.from(base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
      expect(info.width).toBeGreaterThan(0);
      expect(info.height).toBe(info.width);
    }
  }
});

test('the pixel cube has no anti-aliasing: every pixel is opaque or empty', () => {
  for (const size of Object.keys(PIXEL_CUBES).map(Number)) {
    const pixels = pixelCube(size);
    const alphas = new Set();
    for (let i = 3; i < pixels.length; i += 4) alphas.add(pixels[i]);
    expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);
  }
});

test('the pixel cube is outlined: no cube pixel touches an empty one', () => {
  const size = 16;
  const pixels = pixelCube(size);
  const at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? null : pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = at(x, y);
      const isOutline = pixel[3] === 255 && pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0;
      if (pixel[3] === 0 || isOutline) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = at(x + dx, y + dy);
        expect(next !== null && next[3] === 255).toBe(true);
      }
    }
  }
});

test('an .ico directory points at each PNG with its size', () => {
  const pngs = [{ size: 16, png: Buffer.from('a') }, { size: 256, png: Buffer.from('bcd') }];
  const ico = encodeIco(pngs);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(2);
  expect(ico.readUInt8(6)).toBe(16);
  // 256 px is written as 0.
  expect(ico.readUInt8(6 + 16)).toBe(0);
  const offset = ico.readUInt32LE(6 + 16 + 12);
  expect(ico.subarray(offset, offset + 3).toString()).toBe('bcd');
});
