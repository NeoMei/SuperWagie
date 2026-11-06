export const OFFICE_LIMITS = Object.freeze({
  compressedBytes: 256 * 1024 * 1024, inflatedBytes: 512 * 1024 * 1024,
  entries: 10000, xmlBytes: 8 * 1024 * 1024, pages: 200,
  dimension: 8192, pagePixels: 16000000, totalPixels: 256000000,
  nodes: 5000, nodeText: 16384, totalText: 1024 * 1024,
  timeoutMs: 120000, inspectTimeoutMs: 30000, processOutput: 16 * 1024 * 1024,
});
export const officeError = (code, message) => Object.assign(new Error(message), { code });
export function documentTimeout(config = {}) {
  const value = config.documentTimeoutMs ?? OFFICE_LIMITS.timeoutMs;
  if (!Number.isFinite(value) || value <= 0 || value > OFFICE_LIMITS.timeoutMs) throw officeError('INVALID_RUNTIME_CONFIG', 'Document timeout must be positive and at most 120000 ms');
  return value;
}
export function validatePages(pages, expectedCount) {
  if (!pages.length) throw officeError('DOCUMENT_RENDER_FAILED', 'Browser renderer produced no pages');
  if (pages.length > OFFICE_LIMITS.pages) throw officeError('DOCUMENT_RESOURCE_LIMIT', 'Office page count exceeds 200');
  if (expectedCount !== undefined && pages.length !== expectedCount) throw officeError('DOCUMENT_RENDER_FAILED', 'Rendered slide count does not match the validated package');
  let total = 0;
  for (const { width, height } of pages) {
    if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= OFFICE_LIMITS.dimension) || width * height > OFFICE_LIMITS.pagePixels) throw officeError('DOCUMENT_RESOURCE_LIMIT', 'Office page dimensions exceed the rendering limit');
    total += width * height;
  }
  if (total > OFFICE_LIMITS.totalPixels) throw officeError('DOCUMENT_RESOURCE_LIMIT', 'Office total pixel count exceeds the rendering limit');
}
export function validateSemanticNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length > OFFICE_LIMITS.nodes) throw officeError('DOCUMENT_RESOURCE_LIMIT', 'Office semantic node count exceeds the limit');
  let total = 0;
  for (const node of nodes) {
    if (typeof node.text !== 'string' || node.text.length > OFFICE_LIMITS.nodeText || typeof node.locator !== 'string' || node.locator.length > 1024) throw officeError('DOCUMENT_RESOURCE_LIMIT', 'Office semantic text exceeds the limit');
    total += node.text.length;
  }
  if (total > OFFICE_LIMITS.totalText) throw officeError('DOCUMENT_RESOURCE_LIMIT', 'Office total semantic text exceeds the limit');
}
export function validatePng(bytes, expected) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.subarray(12, 16).toString() !== 'IHDR') throw officeError('DOCUMENT_RENDER_FAILED', 'Invalid rendered PNG');
  const page = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  validatePages([page]);
  if (expected && (page.width !== expected.width || page.height !== expected.height)) throw officeError('DOCUMENT_RENDER_FAILED', 'Rendered PNG dimensions do not match its page');
  return page;
}

// Element screenshots enclose both fractional document edges in whole pixels.
export function pageRasterSize({ x, y, width, height }) {
  return { width: Math.ceil(x + width - 0.001) - Math.floor(x + 0.001), height: Math.ceil(y + height - 0.001) - Math.floor(y + 0.001) };
}
