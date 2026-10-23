import fs from 'node:fs/promises';

// GYP's argv form bypasses CMD AutoRun output when resolving this dependency.
export async function useDirectNodePtyTargetLookup(bindingPath, writeFile = fs.writeFile) {
  const original = await fs.readFile(bindingPath);
  const source = original.toString('utf8');
  const shellLookup = String.raw`<!(node -p \"require('node-addon-api').targets\")`;
  const argvLookup = String.raw`<!([\"node\", \"-p\", \"require('node-addon-api').targets\"])`;
  if (source.split(shellLookup).length !== 2) {
    throw new Error('Expected exactly one node-addon-api lookup in node-pty binding.gyp; review the dependency before rebuilding');
  }
  try {
    await writeFile(bindingPath, source.replace(shellLookup, argvLookup));
  } catch (error) {
    await fs.writeFile(bindingPath, original);
    throw error;
  }
  return () => fs.writeFile(bindingPath, original);
}
