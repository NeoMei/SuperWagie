import tls from 'node:tls';
import { parseArgs, usage } from './args.mjs';
import { openCodeTlsConnect } from './zen-tls.mjs';

// eslint-disable-next-line no-undef
const OPENCODE_VERSION = __OPENCODE_SERVER_VERSION__;

const main = async () => {
  delete process.env.ELECTRON_RUN_AS_NODE;

  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
    process.exit(2);
  }
  if (options.command === 'version') {
    process.stdout.write(`${OPENCODE_VERSION}\n`);
    return;
  }
  if (options.command === 'unsupported') {
    process.stderr.write(`OpenChamber's built-in OpenCode only runs the server. Install the OpenCode CLI for other commands.\n${usage}\n`);
    process.exit(2);
  }

  // Zen expects the Bun CLI's cipher order. Keep the change inside this
  // server process and preserve explicit process or connection settings.
  if (!/--tls[-_]cipher[-_]list/.test([...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(' '))) {
    tls.connect = openCodeTlsConnect(tls.connect);
  }
  const { fixWindowsFolderWatches } = await import('./windows-folder-watch.mjs');
  fixWindowsFolderWatches();
  const { configureAssets } = await import('./assets.mjs');
  configureAssets(new URL('./assets/', import.meta.url));
  const { run } = await import('./server.mjs');
  run({ ...options, version: OPENCODE_VERSION });
};

await main();
