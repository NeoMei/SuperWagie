import { z } from 'zod';

const purposes = ['embedding', 'rerank', 'vision', 'ocr'];
const purpose = z.enum(purposes);
const projection = z.object({
  status: z.literal('available'),
  models: z.array(z.object({ purpose, model: z.string().min(1).max(200), dimensions: z.number().int().min(1).max(65536).optional() })),
  unavailablePurposes: z.array(purpose).default([]),
});
const unknown = (ids = purposes) => ids.map((entry) => ({
  purpose: entry, modelId: null, errorCode: 'account_key_existing_configuration_unknown',
}));

/** Read-only protection for knowledge models that predate unified bindings. */
export const readAccountKeyLegacyModels = async (getKnowledgeStatus) => {
  let status;
  try { status = await getKnowledgeStatus(); } catch { return unknown(); }
  // A fresh, unprovisioned backend has no knowledge model or index to replace.
  if (status?.provisioned === false) return [];
  const parsed = projection.safeParse(status?.modelConfiguration);
  if (!parsed.success) return unknown();
  const existing = parsed.data.models.map((model) => {
    const row = { purpose: model.purpose, modelId: model.model, errorCode: 'account_key_existing_configuration' };
    if (model.purpose === 'embedding' && model.dimensions !== undefined) row.parameters = { dimensions: model.dimensions };
    return row;
  });
  const configured = new Set(existing.map((model) => model.purpose));
  return [...existing, ...unknown(parsed.data.unavailablePurposes.filter((entry) => !configured.has(entry)))];
};
