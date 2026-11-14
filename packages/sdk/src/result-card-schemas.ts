import { z } from 'zod';
import { GUEST_RESULT_CARDS_MAX } from './result-cards.ts';

export const guestResultCardsSchema = z.object({
  directory: z.string().min(1).max(4096),
  cards: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    taskId: z.string().min(1).max(200).optional(),
    text: z.string().max(2000).optional(),
    version: z.string().max(200).optional(),
    path: z.string().min(1).max(1024).refine((path) => !path.startsWith('/') && !path.startsWith('~')
      && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.includes('\0')
      && !path.split('/').some((part) => part === '.' || part === '..')).optional(),
  }).strict()).max(GUEST_RESULT_CARDS_MAX),
}).strict();
