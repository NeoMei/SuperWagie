import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { encodeIco } from '../../../scripts/brand/raster.mjs';

const icons = new URL('../resources/icons/', import.meta.url);
const source = await readFile(new URL('icon.png', icons));
const sizes = [16, 24, 32, 48, 64, 128, 256];

// Keep the source tile's rounded transparent corners in every Windows frame.
const entries = await Promise.all(sizes.map(async (size) => ({
  size,
  png: await sharp(source).resize(size, size).png().toBuffer(),
})));

await writeFile(new URL('icon.ico', icons), encodeIco(entries));
console.log(`Generated Windows icon at ${sizes.join(', ')} px.`);
