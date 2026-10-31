import { isSupportedOpenCodeVersion, MINIMUM_OPENCODE_VERSION } from '../../web/server/lib/opencode/compatibility.js';

/** Reject incompatible local engines before starting the extension's server. */

/** OpenCode 2.x prints `opencode v2.0.2`; 1.x printed a bare `1.18.30`. */
export const parseOpenCodeVersion = (output: string): string | null => {
  const match = /(\d+)\.(\d+)\.(\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
};

type OpenCodeVersionCheck =
  | { supported: true; version: string }
  | { supported: false; version: string | null; reason: string };

export const checkOpenCodeVersionOutput = (output: string): OpenCodeVersionCheck => {
  const version = parseOpenCodeVersion(output);
  if (!version) {
    return {
      supported: false,
      version: null,
      reason: `Could not read the OpenCode version from "${output.trim() || '(no output)'}". OpenChamber requires OpenCode ${MINIMUM_OPENCODE_VERSION} or newer within 2.x.`,
    };
  }
  if (!isSupportedOpenCodeVersion(version)) {
    return {
      supported: false,
      version,
      reason: `OpenCode ${version} is not supported. OpenChamber requires OpenCode ${MINIMUM_OPENCODE_VERSION} or newer within 2.x. Upgrade OpenCode, or update openchamber.opencodeBinary.`,
    };
  }
  return { supported: true, version };
};
