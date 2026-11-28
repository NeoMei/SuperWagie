// external: https://github.com/anomalyco/opencode/blob/v2.4.2/packages/cli/vite.node.config.ts
import { readFileSync, statSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPluginTypeScriptFile, pluginImportCandidates } from '../../web/server/lib/opencode-trust/plugin-imports.js';
import * as PromiseSdk from '@opencode/plugin';
import * as EffectSdk from '@opencode/plugin/effect';
import { Tool } from '@opencode/schema/tool';

const SDK_EXPORTS = ['Agent', 'Command', 'Connection', 'Credential', 'Integration', 'Model', 'Plugin', 'Provider', 'Reference', 'Skill'];

const pick = (sdk) => Object.fromEntries(SDK_EXPORTS.map((name) => [name, sdk[name]]));

globalThis[Symbol.for('opencode.plugin.v2.promise')] = pick(PromiseSdk);
globalThis[Symbol.for('opencode.plugin.v2.effect')] = { ...pick(EffectSdk), Tool: { Error: Tool.Error } };

const sdkModule = (key, label) => `const sdk = globalThis[Symbol.for(${JSON.stringify(key)})]
if (!sdk) throw new Error(${JSON.stringify(`OpenCode ${label} plugin SDK is unavailable`)})
${SDK_EXPORTS.map((name) => `export const ${name} = sdk.${name}`).join('\n')}`;

const defineModule = (key, label) => `const sdk = globalThis[Symbol.for(${JSON.stringify(key)})]
if (!sdk) throw new Error(${JSON.stringify(`OpenCode ${label} plugin SDK is unavailable`)})
export const define = sdk.Plugin.define`;

const PROMISE = 'opencode.plugin.v2.promise';
const EFFECT = 'opencode.plugin.v2.effect';

const sources = {
  'opencode:plugin-v2': sdkModule(PROMISE, 'Promise'),
  'opencode:plugin-promise-plugin': defineModule(PROMISE, 'Promise'),
  'opencode:plugin-promise-tool': 'export {}',
  'opencode:plugin-v2-effect': sdkModule(EFFECT, 'Effect'),
  'opencode:plugin-v2-effect-plugin': defineModule(EFFECT, 'Effect'),
  'opencode:plugin-v2-effect-tool': `const sdk = globalThis[Symbol.for(${JSON.stringify(EFFECT)})]
if (!sdk) throw new Error("OpenCode Effect plugin SDK is unavailable")
export const Error = sdk.Tool.Error`,
};

const specifiers = {
  '@opencode/plugin': 'opencode:plugin-v2',
  '@opencode/plugin/promise/plugin': 'opencode:plugin-promise-plugin',
  '@opencode/plugin/promise/tool': 'opencode:plugin-promise-tool',
  '@opencode/plugin/effect': 'opencode:plugin-v2-effect',
  '@opencode/plugin/effect/plugin': 'opencode:plugin-v2-effect-plugin',
  '@opencode/plugin/effect/tool': 'opencode:plugin-v2-effect-tool',
};

const TYPESCRIPT_MODE = (() => {
  try {
    stripTypeScriptTypes('enum Marker {}', { mode: 'transform' });
    return 'transform';
  } catch {
    return 'strip';
  }
})();

const typescriptFile = (url) => {
  if (!url?.startsWith('file:')) return null;
  const filename = fileURLToPath(url);
  return isPluginTypeScriptFile(filename) ? filename : null;
};

const installedTypeScript = (url) => {
  const filename = typescriptFile(url);
  return filename?.split(path.sep).includes('node_modules') ? filename : null;
};

// external: https://github.com/anomalyco/opencode/blob/v2.4.1/packages/plugin/src/source.node.ts prepareSource marks a local plugin's modules with this query
const LOCAL_PLUGIN_PARAMETER = '__opencode_reload';

const localPluginTypeScript = (url) => {
  const filename = typescriptFile(url);
  return filename && new URL(url).searchParams.has(LOCAL_PLUGIN_PARAMETER) ? filename : null;
};

const pluginTypeScript = (url) => installedTypeScript(url) ?? localPluginTypeScript(url);

const UNRESOLVED_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

const isFile = (filename) => statSync(filename, { throwIfNoEntry: false })?.isFile() === true;

const resolvePluginImport = (specifier, context, error) => {
  if (!UNRESOLVED_CODES.has(error?.code)) return null;
  if (context.conditions?.includes('require')) return null;
  const parentFile = pluginTypeScript(context.parentURL);
  if (!parentFile) return null;
  const found = pluginImportCandidates(parentFile, specifier).find(isFile);
  return found ? pathToFileURL(found).href : null;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = specifiers[specifier];
    if (url) return { url, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const pluginImport = resolvePluginImport(specifier, context, error);
      if (pluginImport) return nextResolve(pluginImport, context);
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const source = sources[url];
    if (source) return { format: 'module', source, shortCircuit: true };
    const installed = installedTypeScript(url);
    if (installed) {
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(installed, 'utf8'), { mode: TYPESCRIPT_MODE }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
