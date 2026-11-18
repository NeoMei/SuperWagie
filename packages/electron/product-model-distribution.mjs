import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const fileName = 'product-model-origin.json';
const originSchema = z.string().transform((value, context) => {
  const url = URL.parse(value);
  if (url?.protocol === 'https:' && url.href === `${url.origin}/`) return url.origin;
  context.addIssue({ code: 'custom', message: 'Expected an HTTPS origin' });
  return z.NEVER;
});
const distributionSchema = z.object({ origin: originSchema }).strict();

export function stageProductModelOrigin(resourcesPath, configuredOrigin) {
  const file = path.join(resourcesPath, fileName);
  if (!configuredOrigin) {
    fs.rmSync(file, { force: true });
    return;
  }
  const result = originSchema.safeParse(configuredOrigin);
  if (!result.success) throw new Error('product_model_origin_invalid');
  fs.writeFileSync(file, JSON.stringify({ origin: result.data }) + '\n');
}

export function loadPackagedProductModelOrigin(packaged, resourcesPath) {
  if (!packaged) return undefined;
  let text;
  try {
    text = fs.readFileSync(path.join(resourcesPath, fileName), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return distributionSchema.parse(JSON.parse(text)).origin;
  } catch {
    throw new Error('product_model_origin_invalid');
  }
}
