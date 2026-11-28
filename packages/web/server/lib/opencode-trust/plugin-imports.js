import path from 'node:path';

// external: https://bun.com/docs/runtime/module-resolution Bun's order for these suffixes, as Bun 1.4.4 resolves them inside node_modules and in a checkout
const INSTALLED_EXTENSIONS = ['.mjs', '.mts', '.js', '.cjs', '.ts', '.json'];
const CHECKOUT_EXTENSIONS = ['.mts', '.ts', '.mjs', '.js', '.cjs', '.json'];

const TYPESCRIPT_SUBSTITUTIONS = new Map([
  ['.js', ['.ts', '.mts']],
  ['.mjs', ['.mts']],
]);

export const isPluginTypeScriptFile = (filename) => ['.ts', '.mts'].includes(path.extname(filename));

export const isRelativePluginImport = (specifier) => specifier.startsWith('./') || specifier.startsWith('../');

// Called after Node's ordinary ESM resolution. The importer is the real file
// owning the import, including when the plugin entry was opened via a symlink.
export const pluginImportCandidates = (parentFile, specifier) => {
  if (!isRelativePluginImport(specifier)) return [];
  const target = path.resolve(path.dirname(parentFile), specifier);
  const extensions = parentFile.split(path.sep).includes('node_modules') ? INSTALLED_EXTENSIONS : CHECKOUT_EXTENSIONS;
  const indexes = extensions.map((suffix) => path.join(target, 'index' + suffix));
  if (specifier.endsWith('/')) return indexes;
  const extension = path.extname(specifier);
  if (!extension) return [...extensions.map((suffix) => target + suffix), ...indexes];
  return (TYPESCRIPT_SUBSTITUTIONS.get(extension) ?? []).map((suffix) => target.slice(0, -extension.length) + suffix);
};
