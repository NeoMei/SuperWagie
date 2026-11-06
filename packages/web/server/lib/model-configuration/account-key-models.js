import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200).refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
const modality = z.enum(['text', 'image', 'audio', 'video', 'pdf']);
export const accountModelSchema = z.object({
  id: identifier, name: z.string().trim().min(1).max(200),
  package: z.enum(['aisdk:@ai-sdk/openai', 'aisdk:@ai-sdk/anthropic', 'aisdk:@ai-sdk/google']).optional(),
  inputModalities: z.array(modality).max(5).optional(),
}).strict();

const nativePackages = { responses: 'aisdk:@ai-sdk/openai', claude: 'aisdk:@ai-sdk/anthropic', gemini: 'aisdk:@ai-sdk/google' };
export const isAccountChatModel = (model) => model.operations.some((operation) => operation === 'chat' || Object.hasOwn(nativePackages, operation));
export const accountChatModel = (model) => {
  const result = { id: model.id, name: model.name };
  if (!model.operations.includes('chat')) {
    const operation = model.operations.find((value) => Object.hasOwn(nativePackages, value));
    if (operation) result.package = nativePackages[operation];
  }
  const input = model.input_modalities?.filter((value) => modality.safeParse(value).success);
  if (input?.length) result.inputModalities = [...new Set(input)];
  return result;
};

/** OpenCode selects the native adapter per model and inherits the provider Key. */
export const accountProviderModels = (models, baseUrl) => Object.fromEntries(models.map((model) => {
  const config = { name: model.name };
  if (model.package) config.package = model.package;
  if (model.package === 'aisdk:@ai-sdk/google') config.settings = { baseURL: baseUrl.replace(/\/v1$/, '/v1beta') };
  if (model.inputModalities) config.capabilities = { input: model.inputModalities, output: ['text'] };
  return [model.id, config];
}));
