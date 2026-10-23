import { z } from 'zod';

export const credentialSourceSchema = z.object({ type: z.literal('opencode'), providerId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/) }).strict();
const credentialsSchema = z.record(z.string(), z.union([
  z.object({ type: z.literal('api'), key: z.string().trim().min(1) }),
  z.object({ type: z.literal('oauth') }),
]));
const metadataSchema = z.array(z.object({ providerId: z.string(), name: z.string().optional(), baseUrl: z.string().url().optional() }));

// A known credential may only leave for that provider's official API. Coding
// subscriptions are intentionally absent: their keys have different scopes.
const providerFamilies = [
  { ids: ['openai'], protocols: ['openai-compatible'], hosts: ['api.openai.com'] },
  { ids: ['anthropic'], protocols: ['anthropic'], hosts: ['api.anthropic.com'] },
  { ids: ['google', 'google-ai', 'gemini'], protocols: ['gemini', 'openai-compatible'], hosts: ['generativelanguage.googleapis.com'] },
  { ids: ['aliyun', 'alibaba', 'alibaba-cn', 'dashscope', 'qwen'], protocols: ['aliyun'], hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'], workspace: true },
  { ids: ['deepseek'], protocols: ['openai-compatible'], hosts: ['api.deepseek.com'] },
  { ids: ['glm', 'zhipu', 'zai', 'zhipuai'], protocols: ['openai-compatible'], hosts: ['open.bigmodel.cn', 'api.z.ai'] },
  { ids: ['kimi', 'moonshot', 'moonshotai', 'moonshotai-cn'], protocols: ['openai-compatible'], hosts: ['api.moonshot.cn', 'api.moonshot.ai'] },
  { ids: ['volcengine', 'volcengine-cn', 'doubao'], protocols: ['volcengine'], hosts: ['ark.cn-beijing.volces.com'] },
  { ids: ['mistral'], protocols: ['mistral-ocr', 'openai-compatible'], hosts: ['api.mistral.ai'] },
  { ids: ['cohere'], protocols: ['cohere'], hosts: ['api.cohere.com'] },
  { ids: ['voyage', 'voyageai'], protocols: ['voyage'], hosts: ['api.voyageai.com'] },
  { ids: ['elevenlabs'], protocols: ['elevenlabs'], hosts: ['api.elevenlabs.io'] },
  { ids: ['deepgram'], protocols: ['deepgram'], hosts: ['api.deepgram.com'] },
  { ids: ['minimax', 'minimax-cn'], protocols: ['minimax'], hosts: ['api.minimax.cn', 'api.minimax.io'] },
];
const normalizeUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
};

/** Metadata is authoritative server input, never supplied by the connection form. */
export const credentialDestinationAllowed = (connection, metadata = []) => {
  const providerId = connection.credentialSource.providerId;
  const destination = normalizeUrl(connection.baseUrl);
  if (!destination) return false;
  const native = metadata.find((entry) => entry.providerId === providerId);
  if (native?.baseUrl && connection.providerId === providerId && normalizeUrl(native.baseUrl) === destination) return true;
  const family = providerFamilies.find((entry) => entry.ids.includes(providerId));
  if (!family || !family.ids.includes(connection.providerId) || !family.protocols.includes(connection.protocol)) return false;
  const url = new URL(destination);
  if (url.protocol !== 'https:' || url.port) return false;
  return family.hosts.includes(url.hostname) || Boolean(family.workspace && /^[a-z0-9][a-z0-9-]*\.(?:cn-beijing|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(url.hostname));
};

/** No key is projected from this reader; callers retain its private snapshot only for one operation. */
export const createCredentialReader = ({ readOpenCodeCredentials, readOpenCodeProviderMetadata } = {}) => async () => {
  if (!readOpenCodeCredentials) return { status: 'unavailable', sources: [], credentials: {}, metadata: [] };
  try {
    const [rawCredentials, rawMetadata] = await Promise.all([readOpenCodeCredentials(), readOpenCodeProviderMetadata ? readOpenCodeProviderMetadata() : []]);
    const credentials = credentialsSchema.parse(rawCredentials);
    const metadata = metadataSchema.parse(rawMetadata);
    const sources = Object.entries(credentials)
      .filter(([providerId, entry]) => entry.type === 'api' && (providerFamilies.some((family) => family.ids.includes(providerId)) || metadata.some((item) => item.providerId === providerId && normalizeUrl(item.baseUrl))))
      .map(([providerId]) => {
        const name = metadata.find((entry) => entry.providerId === providerId)?.name;
        const source = { type: 'opencode', providerId };
        if (name) source.name = name;
        return source;
      });
    return { status: 'available', sources, credentials, metadata };
  } catch { return { status: 'failed', sources: [], credentials: {}, metadata: [] }; }
};
