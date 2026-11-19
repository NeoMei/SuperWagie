import { z } from 'zod';

export const PRODUCT_OCR_MODEL = 'PaddleOCR-VL-1.6';
export const PRODUCT_OCR_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const OCR_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const productOcrCallId = /^swocr_[a-f0-9]{60}$/;
export const productOcrRefusals = new Map([
  ['product_membership_expired', 403],
  ['platform_model_credits_required', 402],
  ['invalid_ocr_document', 400],
]);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const pageSchema = z.object({
  index: z.number().int().nonnegative().optional(), width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
  text: z.string(), layout: z.array(z.object({ label: z.string(), content: z.string(), bbox: z.array(z.number().finite()).length(4).optional() })).max(100000),
}).strict();
export const ocrDocumentSchema = z.object({ id: identifier, pages: z.array(pageSchema).min(1).max(1000) }).strict();
export const productOcrStatusSchema = z.object({
  code: z.literal(0), data: z.object({ jobId: identifier, state: z.enum(['pending', 'running', 'done', 'failed']),
    extractProgress: z.object({ totalPages: z.number().int().nonnegative(), extractedPages: z.number().int().nonnegative() }),
  }),
});
export function paddleDocumentResult(document) {
  return { result: { layoutParsingResults: document.pages.map((page) => {
    const prunedResult = { parsing_res_list: page.layout.map((block) => {
      const value = { block_label: block.label, block_content: block.content };
      if (block.bbox) value.block_bbox = block.bbox;
      return value;
    }) };
    if (page.index !== undefined) prunedResult.page_index = page.index;
    if (page.width !== undefined) prunedResult.width = page.width;
    if (page.height !== undefined) prunedResult.height = page.height;
    return { markdown: { text: page.text }, prunedResult };
  }) } };
}
