import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const productHelpOperationSchema = z.enum(['language-en', 'language-zh-CN', 'theme-light', 'theme-dark', 'theme-system']);
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1).max(100), kind: z.literal('locate'), target: z.enum(['models', 'knowledge', 'appearance', 'theme', 'shortcuts']) }).strict(),
  z.object({ id: z.string().min(1).max(100), kind: z.literal('guide'), target: z.enum(['models', 'knowledge', 'appearance', 'theme', 'shortcuts']) }).strict(),
  z.object({ id: z.string().min(1).max(100), kind: z.literal('execute'), operation: productHelpOperationSchema }).strict(),
]);
const sourceSchema = z.object({ id: z.string().min(1).max(100), title: z.string().min(1).max(300) });
const articleSchema = sourceSchema.extend({ text: z.string().max(16000), actions: z.array(actionSchema).max(8) });
export const productHelpAnswerSchema = z.object({
  kind: z.enum(['answer', 'out-of-scope', 'not-covered']), text: z.string().min(1).max(24000),
  sources: z.array(sourceSchema).max(12), actions: z.array(actionSchema).max(24),
  mode: z.enum(['model', 'local']), modelStatus: z.enum(['available', 'unconfigured', 'unavailable', 'not-used']),
});
const articlesSchema = z.object({ articles: z.array(articleSchema).max(100), catalogVersion: z.string() });
export type ProductHelpAnswer = z.infer<typeof productHelpAnswerSchema>;
export type ProductHelpArticle = z.infer<typeof articleSchema>;
export type ProductHelpAction = z.infer<typeof actionSchema>;
export type ProductHelpNavigationAction = Exclude<ProductHelpAction, { kind: 'execute' }>;
export type ProductHelpOperation = z.infer<typeof productHelpOperationSchema>;
export type ProductHelpRequest = {
  question: string; locale: 'en' | 'zh-CN'; context: { page: string };
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  providerID?: string; modelID?: string; directory?: string;
};

export class ProductHelpError extends Error {
  constructor(readonly code: 'unsupported' | 'request' | 'invalid-response') { super(code); this.name = 'ProductHelpError'; }
}
async function readResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw new ProductHelpError(response.status === 501 ? 'unsupported' : 'request');
  try {
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new ProductHelpError('invalid-response');
    return parsed.data;
  } catch { throw new ProductHelpError('invalid-response'); }
}
export async function requestProductHelp(request: ProductHelpRequest, signal: AbortSignal): Promise<ProductHelpAnswer> {
  const response = await runtimeFetch('/api/product-help/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  const answer = await readResponse(response, productHelpAnswerSchema);
  if (answer.kind !== 'answer' && (answer.actions.length || answer.sources.length)) throw new ProductHelpError('invalid-response');
  return answer;
}
export async function loadProductHelpArticles(locale: ProductHelpRequest['locale'], signal: AbortSignal): Promise<ProductHelpArticle[]> {
  const response = await runtimeFetch('/api/product-help/articles', { query: { locale }, signal });
  return (await readResponse(response, articlesSchema)).articles;
}
