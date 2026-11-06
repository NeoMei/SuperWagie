import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Source tests can reuse an explicitly prepared, pinned engine dependency tree.
// Installed engines resolve their own dependencies without this test-only hook.
const engine = process.env.SUPERVIDEO_TEST_ENGINE;
const dependencies = process.env.SUPERVIDEO_TEST_DEPENDENCIES;
if (engine && dependencies) {
  const requireDependency = createRequire(join(dependencies, 'package.json'));
  const pins = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8')).dependencies;
  for (const [name, version] of Object.entries(pins)) {
    const installed = JSON.parse(readFileSync(join(dependencies, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error(`SuperVideo test dependency differs: ${name}`);
  }
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(`${pathToFileURL(engine).href}/`) &&
          Object.keys(pins).some(name => specifier === name || specifier.startsWith(`${name}/`))) {
        return { url: pathToFileURL(requireDependency.resolve(specifier)).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}
