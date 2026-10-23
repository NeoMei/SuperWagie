import path from 'node:path';

/** Child skills read the active server's store through its private resolver. */
export const modelConfigurationChildEnvironment = ({ serverDirectory, dataDir, execPath = process.execPath, openCodePort, openCodeHostname }) => {
  const asarSegment = `.asar${path.sep}`;
  const packaged = serverDirectory.includes(asarSegment);
  const directory = packaged
    ? serverDirectory.replace(asarSegment, `.asar.unpacked${path.sep}`)
    : serverDirectory;
  const host = !openCodeHostname || ['0.0.0.0', '::', '[::]'].includes(openCodeHostname)
    ? '127.0.0.1'
    : openCodeHostname.includes(':') && !openCodeHostname.startsWith('[') ? `[${openCodeHostname}]` : openCodeHostname;
  const environment = {
    OPENCHAMBER_DATA_DIR: dataDir,
    SUPERWAGIE_MODEL_NODE: execPath,
    SUPERWAGIE_MODEL_RESOLVER: path.join(directory, ...(packaged
      ? ['generated', 'model-resolver.mjs']
      : ['lib', 'model-configuration', 'resolve-cli.js'])),
  };
  if (openCodePort) environment.SUPERWAGIE_MODEL_OPENCODE_URL = new URL(`http://${host}:${openCodePort}`).origin;
  return environment;
};
