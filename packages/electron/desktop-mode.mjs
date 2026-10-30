import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const distributionSchema = z.object({ mode: z.literal('remote-client') }).strict();

/** Packaged distribution policy cannot be overridden by inherited shell settings. */
export function configurePackagedDesktopMode({ packaged, resourcesPath, environment }) {
  if (!packaged) return 'standard';
  let text;
  try {
    text = fs.readFileSync(path.join(resourcesPath, 'desktop-mode.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return 'standard';
    throw error;
  }
  let distribution;
  try {
    distribution = distributionSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error('desktop_mode_invalid', { cause: error });
  }
  environment.OPENCHAMBER_SKIP_LOCAL_SERVER = '1';
  return distribution.mode;
}
