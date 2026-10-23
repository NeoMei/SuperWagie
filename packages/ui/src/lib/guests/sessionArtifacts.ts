type SessionArtifact = { path: string; name: string };

const ARTIFACT_EXTENSION = /\.(?:docx|doc|pdf|pptx|ppt|mp4|mov|html?)$/i;
const ARTIFACT_EXTENSION_FRAGMENT = '(?:docx|doc|pdf|pptx|ppt|mp4|mov|html?)';
const RAW_PATH = new RegExp(`(?:^|[\\s("'\`\\[：:])((?:file://|[a-z]:[/\\\\]|~|/)[^\\s"'\`<>]+?\\.${ARTIFACT_EXTENSION_FRAGMENT})(?=$|[\\s)"'\`\\]>,，。；;、])`, 'gi');
const CODE_SPAN = /`([^`\n]+)`/g;
const MARKDOWN_TARGET = /\]\(([^)\n]+)\)/g;
const FILE_URL = /file:\/\/[^\s)"'`<>]+/gi;

const trimCandidate = (value: string): string => value
  .trim()
  .replace(/^[("'`]+|[)"'`，。；;、]+$/g, '')
  .replace(/[.,;:]+$/g, '');

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeCandidate = (raw: string, directory: string): SessionArtifact | null => {
  let candidate = trimCandidate(raw);
  if (!candidate || candidate.startsWith('data:') || /^https?:\/\//i.test(candidate)) return null;
  if (/^file:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      const path = decode(url.pathname);
      candidate = url.hostname ? `//${url.hostname}${path}` : path.replace(/^\/([A-Za-z]:\/)/, '$1');
    } catch {
      return null;
    }
  } else if (candidate.startsWith('//')) {
    return null;
  }
  candidate = trimCandidate(candidate).replace(/\\/g, '/');
  if (!candidate || !ARTIFACT_EXTENSION.test(candidate)) return null;
  if (/\/planning\/|\/generation\/|\/style-selection\./i.test(candidate)) return null;
  if (!candidate.startsWith('/') && !candidate.startsWith('~/') && !/^[A-Za-z]:\//.test(candidate)) {
    candidate = `${directory.replace(/\\/g, '/').replace(/\/+$/, '')}/${candidate}`;
  }
  const name = decode(candidate.slice(candidate.lastIndexOf('/') + 1));
  return name ? { path: candidate, name } : null;
};

/** Paths an assistant put in its answer, in the order they appear. */
export const sessionArtifactsInText = (text: string, directory: string): SessionArtifact[] => {
  const found = new Map<string, SessionArtifact>();
  const scan = (regex: RegExp): void => {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const artifact = normalizeCandidate(match[1] ?? match[0], directory);
      if (artifact) found.set(artifact.path, artifact);
    }
  };
  scan(CODE_SPAN);
  scan(MARKDOWN_TARGET);
  scan(FILE_URL);
  scan(RAW_PATH);
  return [...found.values()];
};
