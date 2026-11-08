import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openUsageActivityJournal } from './usage-activity-journal.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const scope = {
  issuer: 'https://identity.example', api: 'https://billing.example/', clientId: 'superwagie-headless',
  userId: 'alice', accountId: 'account-a', originProductId: 'superwagie', instanceId: 'default',
  visibility: 'account', financialDetails: true,
};
const snapshot = (values = {}) => ({
  date: '2026-11-08', calls: '6201', coveredUntil: '2026-11-09T00:00:00.000Z',
  observedAt: '2026-11-09T00:01:00.000Z', unknownTime: '2', expectedRevision: 0, ...values,
});
const setup = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-activity-journal-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const open = async () => {
    const journal = await openUsageActivityJournal({ dataDir });
    cleanups.push(() => journal.close());
    return journal;
  };
  return { dataDir, open, filename: path.join(dataDir, 'unihub-usage', 'activity.sqlite') };
};

describe('durable daily activity journal', () => {
  it('keeps more than 5000 calls and old calendar years after reopening', async () => {
    const f = await setup();
    const journal = await f.open();
    await journal.writeDay(scope, snapshot());
    await journal.writeDay(scope, snapshot({ date: '2006-01-01', calls: '17', coveredUntil: '2006-01-02T00:00:00Z' }));
    await journal.close();
    const reopened = await f.open();
    expect((await reopened.readDays(scope, '2006-01-01', '2006-01-02'))[0].calls).toBe('17');
    expect((await reopened.readDays(scope, '2026-11-08', '2026-11-09'))[0]).toMatchObject({ calls: '6201', revision: 1, needsReview: false });
  });

  it('preserves exact large integers and updates a daily total without adding it twice', async () => {
    const journal = await (await setup()).open();
    await journal.writeDay(scope, snapshot({ calls: '90071992547409931234567890' }));
    const duplicate = await journal.writeDay(scope, snapshot({ calls: '90071992547409931234567890', expectedRevision: 1 }));
    expect(duplicate).toMatchObject({ applied: false, reason: 'duplicate', day: { revision: 1 } });
    const result = await journal.writeDay(scope, snapshot({ calls: '90071992547409931234567891', expectedRevision: 1, observedAt: '2026-11-09T00:02:00Z' }));
    expect(result).toMatchObject({ applied: true, day: { calls: '90071992547409931234567891', revision: 2 } });
  });

  it('rejects an old CAS even when the delayed response has a later timestamp', async () => {
    const journal = await (await setup()).open();
    await journal.writeDay(scope, snapshot());
    const stale = await journal.writeDay(scope, snapshot({ calls: '7000', observedAt: '2026-11-09T01:00:00Z' }));
    expect(stale).toMatchObject({ applied: false, reason: 'stale_revision', day: { calls: '6201', revision: 1 } });
  });

  it('rejects older timestamps and shorter coverage, including nanosecond ordering', async () => {
    const journal = await (await setup()).open();
    await journal.writeDay(scope, snapshot({ observedAt: '2026-11-09T00:01:00.000000002Z' }));
    const earlier = await journal.writeDay(scope, snapshot({ calls: '6202', expectedRevision: 1, observedAt: '2026-11-09T00:01:00.000000001Z' }));
    expect(earlier.reason).toBe('stale_snapshot');
    const shorter = await journal.writeDay(scope, snapshot({ calls: '6202', expectedRevision: 1, coveredUntil: '2026-11-08T23:00:00Z', observedAt: '2026-11-09T00:02:00Z' }));
    expect(shorter.reason).toBe('stale_snapshot');
    const later = await journal.writeDay(scope, snapshot({ calls: '6202', expectedRevision: 1, observedAt: '2026-11-09T00:01:00.000000003Z' }));
    expect(later.applied).toBe(true);
  });

  it('retains an archived count when a new report decreases and marks it for review', async () => {
    const journal = await (await setup()).open();
    await journal.writeDay(scope, snapshot());
    const decreased = await journal.writeDay(scope, snapshot({ calls: '0', expectedRevision: 1, observedAt: '2026-11-09T01:00:00Z' }));
    expect(decreased.day).toMatchObject({ calls: '6201', reportedCalls: '0', needsReview: true, revision: 2 });
    const restored = await journal.writeDay(scope, snapshot({ calls: '6300', expectedRevision: 2, observedAt: '2026-11-09T02:00:00Z' }));
    expect(restored.day).toMatchObject({ calls: '6300', reportedCalls: '6300', needsReview: false, revision: 3 });
  });

  it('distinguishes missing dates from authoritative zero and keeps unknown-time scope-wide', async () => {
    const journal = await (await setup()).open();
    expect(await journal.readState(scope)).toEqual({ unknownTime: null, observedAt: null, firstDate: null, lastDate: null });
    expect(await journal.readDays(scope, '2026-11-07', '2026-11-10')).toEqual([]);
    await journal.writeDay(scope, snapshot({ calls: '0', unknownTime: '9007199254740993' }));
    await journal.writeDay(scope, snapshot({ date: '2026-11-09', calls: '3', coveredUntil: '2026-11-09T01:00:00Z', observedAt: '2026-11-09T01:01:00Z', unknownTime: '9007199254740993' }));
    expect((await journal.readDays(scope, '2026-11-07', '2026-11-10')).map(day => day.date)).toEqual(['2026-11-08', '2026-11-09']);
    expect((await journal.readDays(scope, '2026-11-08', '2026-11-09')).map(day => day.calls)).toEqual(['0']);
    expect(await journal.readState(scope)).toEqual({ unknownTime: '9007199254740993', observedAt: '2026-11-09T01:01:00Z', firstDate: '2026-11-08', lastDate: '2026-11-09' });
  });

  it.each([
    ['issuer', 'https://other-identity.example'], ['api', 'https://other-billing.example/'],
    ['clientId', 'other-client'], ['userId', 'bob'], ['accountId', 'account-b'],
    ['originProductId', 'other-product'], ['instanceId', 'other-instance'], ['source', 'managed_model'],
    ['financialDetails', false],
  ])('isolates a changed %s scope', async (field, value) => {
    const journal = await (await setup()).open();
    await journal.writeDay(scope, snapshot());
    expect(await journal.readDays({ ...scope, [field]: value }, '2026-11-08', '2026-11-09')).toEqual([]);
  });

  it('separates actor and account visibility and rejects mismatched actor authority', async () => {
    const journal = await (await setup()).open();
    await journal.writeDay(scope, snapshot());
    const own = { ...scope, visibility: 'actor', actorId: 'alice', financialDetails: false };
    expect(await journal.readDays(own, '2026-11-08', '2026-11-09')).toEqual([]);
    await journal.writeDay(own, snapshot({ calls: '1' }));
    expect((await journal.readDays(own, '2026-11-08', '2026-11-09'))[0].calls).toBe('1');
    await expect(journal.readDays({ ...own, actorId: 'bob' }, '2026-11-08', '2026-11-09')).rejects.toMatchObject({ code: 'platform_activity_journal_invalid' });
    await expect(journal.writeDay({ ...scope, token: 'must-not-be-persisted' }, snapshot())).rejects.toMatchObject({ code: 'platform_activity_journal_invalid' });
  });

  it('lets two connections compete atomically without losing the winning snapshot', async () => {
    const f = await setup();
    const first = await f.open();
    const second = await f.open();
    const results = await Promise.all([first.writeDay(scope, snapshot()), second.writeDay(scope, snapshot({ calls: '7000' }))]);
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect(results.filter(result => result.reason === 'stale_revision')).toHaveLength(1);
    expect((await second.readDays(scope, '2026-11-08', '2026-11-09'))[0].revision).toBe(1);
  });

  it('reports a competing transaction as busy without changing or dropping the existing day', async () => {
    const f = await setup();
    const journal = await f.open();
    await journal.writeDay(scope, snapshot());
    const competing = new DatabaseSync(f.filename);
    competing.exec('BEGIN IMMEDIATE');
    try {
      await expect(journal.writeDay(scope, snapshot({ calls: '7000', expectedRevision: 1, observedAt: '2026-11-09T02:00:00Z' }))).rejects.toMatchObject({ code: 'platform_activity_journal_busy' });
    } finally { competing.exec('ROLLBACK'); competing.close(); }
    expect((await journal.readDays(scope, '2026-11-08', '2026-11-09'))[0]).toMatchObject({ calls: '6201', revision: 1 });
    expect((await journal.writeDay(scope, snapshot({ calls: '7000', expectedRevision: 1, observedAt: '2026-11-09T02:00:00Z' }))).applied).toBe(true);
  });

  it('treats omitted and explicit null source selectors as the same persisted scope', async () => {
    const journal = await (await setup()).open();
    await journal.writeDay(scope, snapshot());
    expect((await journal.readDays({ ...scope, actorId: null, source: null }, '2026-11-08', '2026-11-09'))[0].calls).toBe('6201');
    await journal.close();
    await expect(journal.readState(scope)).rejects.toMatchObject({ code: 'platform_activity_journal_closed' });
  });

  it('rolls back a real failed SQLite write and leaves the previous day and state intact', async () => {
    const f = await setup();
    const journal = await f.open();
    await journal.writeDay(scope, snapshot());
    const before = await journal.readState(scope);
    const db = new DatabaseSync(f.filename);
    try {
      db.exec("CREATE TRIGGER fail_activity_update BEFORE UPDATE ON activity_days BEGIN SELECT RAISE(ABORT, 'controlled write failure'); END");
      await expect(journal.writeDay(scope, snapshot({ calls: '7000', unknownTime: '0', expectedRevision: 1, observedAt: '2026-11-09T02:00:00Z' }))).rejects.toMatchObject({ code: 'platform_activity_journal_write_failed' });
      expect((await journal.readDays(scope, '2026-11-08', '2026-11-09'))[0]).toMatchObject({ calls: '6201', revision: 1 });
      expect(await journal.readState(scope)).toEqual(before);
    } finally { db.exec('DROP TRIGGER fail_activity_update'); db.close(); }
  });

  it('uses private permissions and refuses an unknown schema without changing the database', async () => {
    const f = await setup();
    const journal = await f.open();
    await journal.writeDay(scope, snapshot());
    await journal.close();
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.dirname(f.filename))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(f.filename)).mode & 0o777).toBe(0o600);
    }
    const db = new DatabaseSync(f.filename);
    db.exec('PRAGMA user_version=99'); db.close();
    const before = await fs.readFile(f.filename);
    await expect(f.open()).rejects.toMatchObject({ code: 'platform_activity_journal_invalid' });
    expect(await fs.readFile(f.filename)).toEqual(before);
  });

  it('rejects extra persisted schema and invalid persisted counters', async () => {
    const f = await setup();
    let journal = await f.open();
    await journal.writeDay(scope, snapshot()); await journal.close();
    let db = new DatabaseSync(f.filename);
    db.exec('CREATE TABLE unexpected(secret TEXT)'); db.close();
    await expect(f.open()).rejects.toMatchObject({ code: 'platform_activity_journal_invalid' });
    db = new DatabaseSync(f.filename); db.exec('DROP TABLE unexpected'); db.close();
    journal = await f.open();
    db = new DatabaseSync(f.filename); db.exec("UPDATE activity_days SET calls='bogus'"); db.close();
    await expect(journal.readDays(scope, '2026-11-08', '2026-11-09')).rejects.toMatchObject({ code: 'platform_activity_journal_invalid' });
  });

  it('preserves corrupt bytes and rejects a symlinked database or journal directory', async () => {
    const f = await setup();
    await fs.mkdir(path.dirname(f.filename));
    await fs.writeFile(f.filename, 'broken journal, preserve me');
    const before = await fs.readFile(f.filename);
    await expect(f.open()).rejects.toMatchObject({ code: 'platform_activity_journal_invalid' });
    expect(await fs.readFile(f.filename)).toEqual(before);
    await fs.unlink(f.filename);
    const external = path.join(f.dataDir, 'external'); await fs.writeFile(external, before);
    await fs.symlink(external, f.filename);
    await expect(f.open()).rejects.toMatchObject({ code: 'platform_activity_journal_unsafe' });
    expect(await fs.readFile(external)).toEqual(before);
    await fs.unlink(f.filename); await fs.rmdir(path.dirname(f.filename));
    const externalDir = path.join(f.dataDir, 'other'); await fs.mkdir(externalDir);
    await fs.symlink(externalDir, path.dirname(f.filename), 'dir');
    await expect(f.open()).rejects.toMatchObject({ code: 'platform_activity_journal_unsafe' });
    expect(await fs.readdir(externalDir)).toEqual([]);
  });

  it('refuses symlinked data roots and SQLite sidecars without modifying their targets', async () => {
    const f = await setup();
    const target = path.join(f.dataDir, 'real-root'); await fs.mkdir(target);
    const linked = path.join(f.dataDir, 'linked-root'); await fs.symlink(target, linked, 'dir');
    let accidental;
    try {
      await expect(openUsageActivityJournal({ dataDir: linked }).then(value => { accidental = value; return value; })).rejects.toMatchObject({ code: 'platform_activity_journal_unsafe' });
    } finally { await accidental?.close(); }
    expect(await fs.readdir(target)).toEqual([]);
    const journal = await f.open(); await journal.close();
    const external = path.join(f.dataDir, 'untouched'); await fs.writeFile(external, 'keep me');
    await fs.symlink(external, `${f.filename}-journal`);
    await expect(f.open()).rejects.toMatchObject({ code: 'platform_activity_journal_unsafe' });
    expect(await fs.readFile(external, 'utf8')).toBe('keep me');
  });

  it.each([
    { calls: null }, { calls: '-1' }, { calls: '01' }, { expectedRevision: -1 },
    { date: '2026-02-30' }, { coveredUntil: '2026-11-10T00:00:00Z' },
    { observedAt: '2026-11-08T00:00:00Z' },
  ])('refuses an invalid snapshot without creating a zero day: %j', async values => {
    const journal = await (await setup()).open();
    await expect(journal.writeDay(scope, snapshot(values))).rejects.toMatchObject({ code: 'platform_activity_journal_invalid' });
    expect(await journal.readDays(scope, '2026-11-08', '2026-11-09')).toEqual([]);
  });
});
