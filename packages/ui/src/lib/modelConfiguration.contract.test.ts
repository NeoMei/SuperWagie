import { afterEach, expect, spyOn, test } from 'bun:test';
import { readModelConfiguration } from './modelConfiguration';
// The server's shipped catalog is the contract consumed by the UI.
// @ts-expect-error JavaScript server module has no TypeScript declaration.
import { MODEL_PRESETS, MODEL_PURPOSES } from '../../../web/server/lib/model-configuration/catalog.js';

let restoreFetch: (() => void) | undefined;
afterEach(() => { restoreFetch?.(); restoreFetch = undefined; });

test('accepts the shipped server model catalog', async () => {
  const mock = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    version: 1, revision: 0, enterpriseMode: false, purposes: MODEL_PURPOSES,
    presets: MODEL_PRESETS, connections: [], bindings: [],
    credentialSources: { status: 'available', sources: [] },
  }));
  restoreFetch = () => mock.mockRestore();
  const configuration = await readModelConfiguration();
  expect(configuration.presets.length).toBe(MODEL_PRESETS.length);
});
