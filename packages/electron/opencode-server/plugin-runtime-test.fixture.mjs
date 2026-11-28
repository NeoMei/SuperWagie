// Registers the plugin-runtime hooks from source in a child process and reports
// the `marker` export a plugin import produces. `args[2]` points at
// plugin-runtime.mjs, `args[3]` at the plugin entry to import.
import { pathToFileURL } from 'node:url';

const [runtimePath, pluginEntry, local] = process.argv.slice(2);

// Resolve the installed SDK before the embedded runtime registers its loader.
const prepareSourceURL = new URL('../source.node.js', import.meta.resolve('@opencode/plugin')).href;

await import(pathToFileURL(runtimePath).href);

// With `local` as `args[4]`, import the entry through the pinned OpenCode loader for a
// local plugin (prepareSource in @opencode/plugin), which marks the entry and every module
// outside node_modules it reaches with its reload query. It registers its hook after the
// runtime, as the server does.
const entryURL = pathToFileURL(pluginEntry).href;
const loaded = local === 'local'
  ? await (await (await import(prepareSourceURL)).prepareSource(entryURL, () => {})).load()
  : await import(entryURL);
console.log(JSON.stringify({ marker: loaded.marker }));
