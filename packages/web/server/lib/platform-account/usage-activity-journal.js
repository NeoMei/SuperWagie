import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(2048);
const integer = z.string().max(1024).regex(/^(0|[1-9]\d*)$/);
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true }).regex(/(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
const scopeSchema = z.object({
  issuer: id, api: id, clientId: id, userId: id, accountId: id,
  originProductId: id, instanceId: id, visibility: z.enum(['actor', 'account']),
  actorId: id.nullish().transform(value => value ?? null),
  source: id.nullish().transform(value => value ?? null), financialDetails: z.boolean(),
}).strict().refine(scope => scope.visibility === 'actor'
  ? scope.actorId === scope.userId && !scope.financialDetails : scope.actorId === null);
const daySchema = z.object({
  date, calls: integer, reportedCalls: integer, coveredUntil: timestamp, observedAt: timestamp,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), needsReview: z.union([z.literal(0), z.literal(1)]),
}).strict();
const snapshotSchema = z.object({
  date, calls: integer, coveredUntil: timestamp, observedAt: timestamp, unknownTime: integer,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const DAY = 86_400_000;
const tables = [
  `CREATE TABLE activity_scopes (scope_key TEXT PRIMARY KEY, scope_json TEXT NOT NULL, unknown_time TEXT NOT NULL, observed_at TEXT NOT NULL)`,
  `CREATE TABLE activity_days (scope_key TEXT NOT NULL REFERENCES activity_scopes(scope_key), date TEXT NOT NULL, calls TEXT NOT NULL, reported_calls TEXT NOT NULL, covered_until TEXT NOT NULL, observed_at TEXT NOT NULL, revision INTEGER NOT NULL, needs_review INTEGER NOT NULL, PRIMARY KEY(scope_key,date))`,
];
const columns = 'date,calls,reported_calls AS reportedCalls,covered_until AS coveredUntil,observed_at AS observedAt,revision,needs_review AS needsReview';
const fail = (code, cause) => { throw Object.assign(new Error(code, { cause }), { code }); };
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail('platform_activity_journal_invalid');
  return result.data;
};
// Preserve RFC3339 nanosecond ordering; Date.parse alone truncates sub-ms evidence.
const instant = value => {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail('platform_activity_journal_invalid');
  const milliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(milliseconds)) fail('platform_activity_journal_invalid');
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
};
const validateCoverage = value => {
  const start = BigInt(Date.parse(`${value.date}T00:00:00Z`)) * 1_000_000n;
  const through = instant(value.coveredUntil);
  if (through <= start || through > start + BigInt(DAY) * 1_000_000n || instant(value.observedAt) < through) fail('platform_activity_journal_invalid');
};
const range = (from, to) => {
  parse(date, from); parse(date, to);
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (start > end || end - start > 36_600 * DAY) fail('platform_activity_journal_invalid');
  return { start, end };
};
const scopeIdentity = raw => {
  const scope = parse(scopeSchema, raw);
  const json = JSON.stringify(scope);
  return { json, key: createHash('sha256').update(json).digest('hex') };
};
const storedDay = raw => {
  if (!raw) return null;
  const value = parse(daySchema, raw);
  validateCoverage(value);
  if (BigInt(value.calls) < BigInt(value.reportedCalls) || Boolean(value.needsReview) !== (BigInt(value.calls) > BigInt(value.reportedCalls))) fail('platform_activity_journal_invalid');
  return { ...value, needsReview: Boolean(value.needsReview) };
};
const privateFile = async filename => {
  const stat = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) fail('platform_activity_journal_unsafe');
  return stat;
};

/** Private, durable daily observations. Callers supply freshly authorized scopes; this file grants no authority. */
export const openUsageActivityJournal = async ({ dataDir }) => {
  parse(id, dataDir);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(dataDir)).isDirectory()) fail('platform_activity_journal_unsafe');
  const directory = path.join(dataDir, 'unihub-usage');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) fail('platform_activity_journal_unsafe');
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  const filename = path.join(directory, 'activity.sqlite');
  const existing = await privateFile(filename);
  for (const suffix of ['-journal', '-wal', '-shm']) await privateFile(`${filename}${suffix}`);
  if (existing?.size === 0) fail('platform_activity_journal_invalid');
  let created = false;
  if (!existing) {
    try {
      const handle = await fs.open(filename, 'wx', 0o600);
      await handle.close(); created = true;
    } catch (error) { if (error.code !== 'EEXIST') fail('platform_activity_journal_unavailable', error); }
  }
  await privateFile(filename);
  if (process.platform !== 'win32') await fs.chmod(filename, 0o600);
  let database;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(filename, { timeout: 0 });
    database.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF');
    if (created) {
      database.exec('BEGIN IMMEDIATE');
      try { for (const sql of tables) database.exec(sql); database.exec('PRAGMA user_version=1; COMMIT'); }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    }
    if (database.prepare('PRAGMA user_version').get().user_version !== 1
      || database.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete'
      || database.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
      || database.prepare('PRAGMA foreign_key_check').all().length) fail('platform_activity_journal_invalid');
    const definitions = database.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.sql);
    if (JSON.stringify(definitions) !== JSON.stringify([tables[1], tables[0]])) fail('platform_activity_journal_invalid');
    database.exec('PRAGMA synchronous=FULL');
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original initialization failure. */ }
    if (error.code?.startsWith('platform_activity_journal_')) throw error;
    fail([5, 6].includes(error.errcode) ? 'platform_activity_journal_busy' : 'platform_activity_journal_invalid', error);
  }
  let closed = false;
  const assertOpen = () => { if (closed) fail('platform_activity_journal_closed'); };
  const readScope = identity => {
    const saved = database.prepare('SELECT scope_json,unknown_time,observed_at FROM activity_scopes WHERE scope_key=?').get(identity.key);
    if (!saved) return null;
    if (saved.scope_json !== identity.json) fail('platform_activity_journal_invalid');
    parse(integer, saved.unknown_time); parse(timestamp, saved.observed_at);
    return saved;
  };
  const readDay = (key, utcDate) => storedDay(database.prepare(`SELECT ${columns} FROM activity_days WHERE scope_key=? AND date=?`).get(key, utcDate));
  const readDays = async (scope, from, to) => {
    assertOpen(); range(from, to);
    const identity = scopeIdentity(scope);
    if (!readScope(identity)) return [];
    return database.prepare(`SELECT ${columns} FROM activity_days WHERE scope_key=? AND date>=? AND date<? ORDER BY date`).all(identity.key, from, to).map(storedDay);
  };
  return {
    readDays,
    readState: async scope => {
      assertOpen();
      const identity = scopeIdentity(scope);
      const saved = readScope(identity);
      if (!saved) return { unknownTime: null, observedAt: null, firstDate: null, lastDate: null };
      const dates = database.prepare('SELECT min(date) AS firstDate,max(date) AS lastDate FROM activity_days WHERE scope_key=?').get(identity.key);
      if (dates.firstDate !== null) parse(date, dates.firstDate);
      if (dates.lastDate !== null) parse(date, dates.lastDate);
      return { unknownTime: saved.unknown_time, observedAt: saved.observed_at, firstDate: dates.firstDate, lastDate: dates.lastDate };
    },
    writeDay: async (scope, raw) => {
      assertOpen();
      const identity = scopeIdentity(scope);
      const value = parse(snapshotSchema, raw);
      validateCoverage(value);
      let transaction = false;
      try {
        database.exec('BEGIN IMMEDIATE'); transaction = true;
        const saved = readScope(identity);
        const previous = readDay(identity.key, value.date);
        const refuse = reason => { database.exec('ROLLBACK'); transaction = false; return { applied: false, reason, day: previous }; };
        if ((previous?.revision ?? 0) !== value.expectedRevision) return refuse('stale_revision');
        if (previous) {
          const duplicate = previous.reportedCalls === value.calls && instant(previous.observedAt) === instant(value.observedAt) && instant(previous.coveredUntil) === instant(value.coveredUntil);
          if (duplicate) return refuse('duplicate');
          if (instant(value.observedAt) <= instant(previous.observedAt) || instant(value.coveredUntil) < instant(previous.coveredUntil)) return refuse('stale_snapshot');
        }
        const calls = previous && BigInt(previous.calls) > BigInt(value.calls) ? previous.calls : value.calls;
        const revision = (previous?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) fail('platform_activity_journal_invalid');
        if (!saved) database.prepare('INSERT INTO activity_scopes VALUES(?,?,?,?)').run(identity.key, identity.json, value.unknownTime, value.observedAt);
        else if (instant(value.observedAt) > instant(saved.observed_at)) database.prepare('UPDATE activity_scopes SET unknown_time=?,observed_at=? WHERE scope_key=?').run(value.unknownTime, value.observedAt, identity.key);
        database.prepare('INSERT INTO activity_days VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,date) DO UPDATE SET calls=excluded.calls,reported_calls=excluded.reported_calls,covered_until=excluded.covered_until,observed_at=excluded.observed_at,revision=excluded.revision,needs_review=excluded.needs_review')
          .run(identity.key, value.date, calls, value.calls, value.coveredUntil, value.observedAt, revision, calls === value.calls ? 0 : 1);
        const day = readDay(identity.key, value.date);
        database.exec('COMMIT'); transaction = false;
        return { applied: true, reason: null, day };
      } catch (error) {
        if (transaction) { try { database.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back the failed command. */ } }
        if (error.code?.startsWith('platform_activity_journal_')) throw error;
        fail([5, 6].includes(error.errcode) ? 'platform_activity_journal_busy' : 'platform_activity_journal_write_failed', error);
      }
    },
    close: async () => { if (!closed) { database.close(); closed = true; } },
  };
};
