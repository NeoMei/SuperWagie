import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const payload = fileURLToPath(new URL('../../builtin-skills/', import.meta.url));
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const snapshots = [
  ['superppt', '0.3.6', '91b75cf6514207d3ae3d18d8211b75bd8182dff0'],
  ['skills/superweb', '1.2.0', '0edbf5787c518abcfd199254182be7a5661bb1b9'],
  ['skills/WPSComposer', '0.10.0', '8e6ddbc0943aa04d4292fe26ce9d5deba5ea3046'],
];

describe('bundled component snapshots', () => {
  for (const [directory, version, commit] of snapshots) {
    it(`keeps ${directory} pinned with every shipped file verified`, async () => {
      const root = path.join(payload, directory);
      const receipt = await json(path.join(root, 'VENDOR-SNAPSHOT.json'));
      expect(receipt.version).toBe(version);
      expect(receipt.commit).toBe(commit);
      expect(receipt.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(receipt)).not.toMatch(/\/Users\/|[A-Z]:\\/);
      expect(receipt.files.length).toBeGreaterThan(20);
      for (const file of receipt.files) {
        expect(file.path.split('/')).not.toContain('..');
        const bytes = await readFile(path.join(root, file.path));
        expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.shippedSha256);
      }
    });
  }

  it('retains the complete official SuperPPT catalog and shared dependency graph', async () => {
    const catalog = await json(path.join(payload, 'superppt/skills/superppt/assets/styles/catalog.json'));
    expect(catalog.styles).toHaveLength(11);
    expect(catalog.styles.reduce((count, style) => count + style.previews.length, 0)).toBe(99);
    const manifest = await json(path.join(payload, 'skills/superweb/package.json'));
    const lock = await json(path.join(payload, 'skills/superweb/package-lock.json'));
    expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
    expect(lock.version).toBe(manifest.version);
  });
});
