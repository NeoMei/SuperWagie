// Reviewed technical identity for this bounded pilot. A model alias alone is
// never evidence that an existing index used this space: each new work must
// persist and sign the complete space identity, and old records fail closed.
export const MANAGED_TEXT_EMBEDDING = Object.freeze({
  publicModel: 'unihub-text-embedding-v4',
  upstreamModel: 'text-embedding-v4',
  provider: 'aliyun',
  version: 'v4',
  dimensions: 1024,
  modality: 'text',
  inputSemantics: 'text',
  space: 'aliyun/text-embedding-v4/v4/1024/text',
});

export function managedEmbeddingCatalogEntry(binding) {
  if (binding?.protocol !== 'managed-media' || binding.providerId !== 'unihub' || binding.purpose !== 'embedding' || binding.model !== MANAGED_TEXT_EMBEDDING.publicModel) return null;
  if (binding.parameters?.dimensions !== undefined && binding.parameters.dimensions !== MANAGED_TEXT_EMBEDDING.dimensions) return null;
  return MANAGED_TEXT_EMBEDDING;
}
