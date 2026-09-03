import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RESOURCE_BUDGET,
  RESOURCE_LIMIT_ENFORCEMENT,
  resolveResourceBudget
} from '../resource-budget.mjs';

const EXPECTED_DEFAULTS = {
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
};

test('uses every Viewer design 9.4 ceiling needed by the host adapter', () => {
  assert.deepEqual(DEFAULT_RESOURCE_BUDGET, EXPECTED_DEFAULTS);
  assert.equal(Object.isFrozen(DEFAULT_RESOURCE_BUDGET), true);
});

test('accepts format-specific reductions without mutating the baseline', () => {
  const reductions = Object.fromEntries(
    Object.entries(EXPECTED_DEFAULTS).map(([key, value]) => [key, Math.max(1, value - 1)])
  );
  const reduced = resolveResourceBudget(reductions);

  assert.deepEqual(reduced, reductions);
  assert.deepEqual(DEFAULT_RESOURCE_BUDGET, EXPECTED_DEFAULTS);
  assert.equal(Object.isFrozen(reduced), true);
});

test('classifies each design ceiling by the layer that can actually enforce it', () => {
  assert.deepEqual(Object.keys(RESOURCE_LIMIT_ENFORCEMENT).sort(), Object.keys(EXPECTED_DEFAULTS).sort());
  assert.equal(RESOURCE_LIMIT_ENFORCEMENT.first_content_deadline_ms, 'supervisor_only');
  assert.equal(RESOURCE_LIMIT_ENFORCEMENT.max_worker_rss_bytes, 'supervisor_only');
  assert.equal(RESOURCE_LIMIT_ENFORCEMENT.parse_deadline_ms, 'core_cooperative_supervisor_hard_limit');
  for (const [key, enforcement] of Object.entries(RESOURCE_LIMIT_ENFORCEMENT)) {
    assert.ok(
      ['adapter', 'core_cooperative_supervisor_hard_limit', 'supervisor_only'].includes(enforcement),
      `${key}: ${enforcement}`
    );
  }
  assert.equal(Object.isFrozen(RESOURCE_LIMIT_ENFORCEMENT), true);
});

test('rejects every ceiling increase, unknown key, and invalid numeric limit', () => {
  for (const [key, value] of Object.entries(EXPECTED_DEFAULTS)) {
    assert.throws(
      () => resolveResourceBudget({ [key]: value + 1 }),
      (error) => error.code === 'VIEWER_RESOURCE_LIMIT_INCREASE' && error.limit === key,
      key
    );
  }
  assert.throws(() => resolveResourceBudget({ max_magic_widgets: 1 }), /unknown resource limit/i);
  assert.throws(() => resolveResourceBudget({ max_pages: 0 }), /positive integer/i);
  assert.throws(() => resolveResourceBudget({ max_pages: 1.5 }), /positive integer/i);
});
