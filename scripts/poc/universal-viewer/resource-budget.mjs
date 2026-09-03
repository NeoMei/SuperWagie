export const DEFAULT_RESOURCE_BUDGET = Object.freeze({
  max_detection_bytes: 1_048_576,
  max_input_bytes: 268_435_456,
  max_entry_uncompressed_bytes: 134_217_728,
  max_total_uncompressed_bytes: 536_870_912,
  max_archive_entries: 10_000,
  max_archive_depth: 8,
  max_compression_ratio: 100,
  max_xml_depth: 128,
  max_xml_nodes: 250_000,
  max_xml_text_bytes: 8_388_608,
  max_image_width_px: 100_000_000,
  max_image_height_px: 100_000_000,
  max_image_pixels: 100_000_000,
  max_animation_frames: 10_000,
  max_table_rows: 50_000,
  max_table_columns: 50_000,
  max_table_cells: 50_000,
  max_pages: 5_000,
  max_slides: 5_000,
  max_sheets: 1_024,
  first_content_deadline_ms: 15_000,
  parse_deadline_ms: 60_000,
  max_worker_rss_bytes: 805_306_368,
  max_diagnostics: 256,
  max_text_items: 50_000,
  max_model_items: 50_000
});

// The in-process adapter can enforce bounded input/container/model work. Wall
// clock and resident-memory ceilings still require an external worker
// supervisor; the Core timeout is cooperative and is not a hard deadline.
export const RESOURCE_LIMIT_ENFORCEMENT = Object.freeze({
  max_detection_bytes: 'adapter',
  max_input_bytes: 'adapter',
  max_entry_uncompressed_bytes: 'adapter',
  max_total_uncompressed_bytes: 'adapter',
  max_archive_entries: 'adapter',
  max_archive_depth: 'adapter',
  max_compression_ratio: 'adapter',
  max_xml_depth: 'adapter',
  max_xml_nodes: 'adapter',
  max_xml_text_bytes: 'adapter',
  max_image_width_px: 'adapter',
  max_image_height_px: 'adapter',
  max_image_pixels: 'adapter',
  max_animation_frames: 'adapter',
  max_table_rows: 'adapter',
  max_table_columns: 'adapter',
  max_table_cells: 'adapter',
  max_pages: 'adapter',
  max_slides: 'adapter',
  max_sheets: 'adapter',
  first_content_deadline_ms: 'supervisor_only',
  parse_deadline_ms: 'core_cooperative_supervisor_hard_limit',
  max_worker_rss_bytes: 'supervisor_only',
  max_diagnostics: 'adapter',
  max_text_items: 'adapter',
  max_model_items: 'adapter'
});

export class ResourceBudgetError extends Error {
  constructor(message, { code = 'VIEWER_RESOURCE_LIMIT_INVALID', limit } = {}) {
    super(message);
    this.name = 'ResourceBudgetError';
    this.code = code;
    this.limit = limit;
  }
}

export function resolveResourceBudget(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ResourceBudgetError('resource limits must be an object');
  }

  const resolved = { ...DEFAULT_RESOURCE_BUDGET };
  for (const [limit, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_RESOURCE_BUDGET, limit)) {
      throw new ResourceBudgetError(`unknown resource limit: ${limit}`, { limit });
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ResourceBudgetError(`${limit} must be a positive integer`, { limit });
    }
    if (value > DEFAULT_RESOURCE_BUDGET[limit]) {
      throw new ResourceBudgetError(`${limit} cannot increase the design baseline`, {
        code: 'VIEWER_RESOURCE_LIMIT_INCREASE',
        limit
      });
    }
    resolved[limit] = value;
  }
  return Object.freeze(resolved);
}
