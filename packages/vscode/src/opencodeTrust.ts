import path from 'node:path';
import { createOpenCodeTrust } from '../../web/server/lib/opencode-trust/index.js';
import { getOpenChamberDataDir } from './openchamberSessionState';

export const openCodeTrust = createOpenCodeTrust({
  storePath: path.join(getOpenChamberDataDir(), 'opencode-trust.json'),
});
