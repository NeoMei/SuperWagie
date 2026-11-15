import type { EasterEggCopy } from './copy/types';

const THINKING_LINE_ODDS = 4;
const hashSeed = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
};

/** A stable per-part line for roughly one reasoning block in four. */
export const thinkingLine = (copy: EasterEggCopy, seed: string): string | null => {
  if (hashSeed(seed) % THINKING_LINE_ODDS !== 0 || copy.thinking.length === 0) return null;
  return copy.thinking[hashSeed(`${seed}:line`) % copy.thinking.length];
};
