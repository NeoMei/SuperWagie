import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { assessOpenCodeFolder } from './assessment.js';

export const OPENCODE_TRUST_ROUTE = '/api/opencode/trust';
const OPENCODE_TRUST_REQUIRED = 'opencode_trust_required';
const absPath = z.string().min(1).refine((value) => path.isAbsolute(value));
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const trustQuery = z.object({ directory: absPath });
const trustAnswer = trustQuery.extend({ fingerprint });
const trustDocument = z.object({ version: z.literal(1), repositories: z.record(z.string(), z.array(fingerprint.unwrap())) });
const createSessionBody = z.object({ location: z.object({ directory: absPath }).nullish() }).nullable();
const moveSessionBody = z.object({ directory: z.string().trim().min(1) });

const sessionRoute = /^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/.*)?$/;
const moveRoute = /^\/api\/session\/([^/]+)\/move$/;
const readOnly = [
  /^\/api\/session(?:\/[^/]+(?:\/message(?:\/[^/]+)?)?)?$/,
  /^\/api\/experimental\/session\/stats$/,
  /^\/api\/(?:global\/)?event$/,
  /^\/api\/credential(?:\/|$)/,
  /^\/api\/info$/,
];

const mutationWithoutLocation = (method, pathname) => (
  (method === 'DELETE' && /^\/api\/(?:session\/[^/]+|debug\/location)$/.test(pathname))
  || (method === 'POST' && /^\/api\/session\/[^/]+\/view$/.test(pathname))
);

const headerValue = (headers, key) => {
  const value = new Headers(headers).get(key);
  return value || null;
};

const decoded = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

const namedDirectories = (url, headers) => {
  const directories = [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('location[directory]')];
  const explicit = headerValue(headers, 'x-opencode-directory');
  if (explicit) {
    const encoded = headerValue(headers, 'x-opencode-directory-encoding') === 'uri' || /%[0-9a-f]{2}/i.test(explicit);
    directories.push(encoded ? decoded(explicit) : explicit);
  }
  return directories.filter(Boolean);
};

const refused = (error, status = 503) => ({ status, body: { error } });
const locationUnavailable = () => refused('Could not verify the OpenCode folder before opening it');
const publicAssessment = ({ directory, fingerprint, items }, trusted) => ({ directory, fingerprint, items, trusted });

export const createOpenCodeTrust = ({ storePath, io = fs, homeDirectory = os.homedir(), globalConfigDirectories, getEnvironment = () => process.env, allowDirectory = () => true }) => {
  const empty = () => ({ version: 1, repositories: {} });
  const readStore = async () => {
    try {
      const parsed = trustDocument.safeParse(JSON.parse(await io.readFile(storePath, 'utf8')));
      return parsed.success ? parsed.data : empty();
    } catch {
      return empty();
    }
  };
  const grant = async (repository, digest) => {
    await withSourceControlFileLock(storePath + '.lock', async () => {
      const current = await readStore();
      const previous = current.repositories[repository] || [];
      if (previous.includes(digest)) return;
      current.repositories[repository] = [...previous.slice(-19), digest];
      const temporary = storePath + '.' + randomUUID();
      try {
        await io.writeFile(temporary, JSON.stringify(current), { mode: 0o600, flag: 'wx' });
        await io.rename(temporary, storePath);
      } finally {
        await io.unlink(temporary).catch(() => {});
      }
    }, { fsImpl: io });
  };
  const evaluate = async (directory) => {
    if (!allowDirectory(directory)) throw new Error('This OpenCode folder belongs to another runtime');
    const assessment = await assessOpenCodeFolder(directory, { io, homeDirectory, globalConfigDirectories, environment: getEnvironment() });
    const trusted = assessment.fingerprint === null
      || ((await readStore()).repositories[assessment.repository] || []).includes(assessment.fingerprint);
    return { assessment, trusted };
  };
  const inspect = async (directory) => {
    const { assessment, trusted } = await evaluate(directory);
    return publicAssessment(assessment, trusted);
  };
  const answer = async (directory, confirmed) => {
    const { assessment, trusted } = await evaluate(directory);
    if (assessment.fingerprint !== confirmed) return { ok: false, assessment: publicAssessment(assessment, trusted) };
    if (!trusted && confirmed !== null) await grant(assessment.repository, confirmed);
    return { ok: true, assessment: publicAssessment(assessment, true) };
  };
  const isTrusted = async (directory) => (await evaluate(directory)).trusted;

  const refusalFor = async ({ method = 'GET', path: requestPath, headers, resolveSessionDirectory, readBody, fallbackDirectory, prepareDirectory }) => {
    const url = new URL(requestPath, 'http://opencode.invalid');
    const verb = method.toUpperCase();
    const pathname = url.pathname.replace(/\/+$/, '');
    if (((verb === 'GET' || verb === 'HEAD') && readOnly.some((pattern) => pattern.test(pathname)))
      || mutationWithoutLocation(verb, pathname)) return null;

    const directories = namedDirectories(url, headers);
    const sessionId = sessionRoute.exec(pathname)?.[1];
    const move = verb === 'POST' && moveRoute.test(pathname);
    if (verb === 'POST' && pathname === '/api/session') {
      try {
        const payload = await readBody?.();
        if (payload) {
          const parsed = createSessionBody.safeParse(JSON.parse(payload));
          if (!parsed.success) return refused('Invalid OpenCode session location', 400);
          if (parsed.data?.location) directories.push(parsed.data.location.directory);
        }
      } catch {
        return refused('A session location requires a JSON body', 400);
      }
    }
    let owner = null;
    if (sessionId && sessionId !== 'global') {
      if (!resolveSessionDirectory) return locationUnavailable();
      try {
        owner = await resolveSessionDirectory(decoded(sessionId));
      } catch {
        return locationUnavailable();
      }
      if (owner) directories.push(owner);
    }
    if (move) {
      const destination = await Promise.resolve().then(readBody).then((serialized) => JSON.parse(serialized ?? 'null')).catch(() => null);
      const parsed = moveSessionBody.safeParse(destination);
      if (!parsed.success) return refused('A session move needs a JSON body naming its directory', 400);
      const raw = parsed.data.directory;
      const expanded = raw === '~' ? homeDirectory : raw.startsWith('~/') ? path.join(homeDirectory, raw.slice(2)) : raw;
      if (!path.isAbsolute(expanded) && !owner) return locationUnavailable();
      directories.unshift(path.resolve(owner || homeDirectory, expanded));
    }
    if (directories.length === 0 && fallbackDirectory) directories.push(fallbackDirectory);
    for (const directory of new Set(directories)) {
      if (!path.isAbsolute(directory)) return refused('OpenCode folder paths must be absolute', 400);
      if (!allowDirectory(directory)) return locationUnavailable();
      try {
        const unavailable = await prepareDirectory?.(directory);
        if (unavailable) return unavailable;
        const assessment = await inspect(directory);
        if (!assessment.trusted) {
          return { status: 403, body: { code: OPENCODE_TRUST_REQUIRED, error: 'Review this folder configuration before opening it', directory: assessment.directory } };
        }
      } catch {
        return locationUnavailable();
      }
    }
    return null;
  };

  const handleRoute = async ({ method, query, body }) => {
    try {
      if (method === 'GET') {
        const parsed = trustQuery.safeParse(query);
        return parsed.success ? { status: 200, body: await inspect(parsed.data.directory) } : refused('An absolute folder is required', 400);
      }
      if (method === 'POST') {
        const parsed = trustAnswer.safeParse(body);
        if (!parsed.success) return refused('A folder and current fingerprint are required', 400);
        const result = await answer(parsed.data.directory, parsed.data.fingerprint);
        return { status: result.ok ? 200 : 409, body: result.assessment };
      }
      return refused('Method not supported', 405);
    } catch {
      return locationUnavailable();
    }
  };
  return { inspect, answer, isTrusted, refusalFor, handleRoute };
};
