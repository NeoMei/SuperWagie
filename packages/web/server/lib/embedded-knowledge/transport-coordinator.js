import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { knowledgeModelParameters } from './model-bindings.js';
import { planHyTransportRebind } from '../hy-memory/transport-rebind.js';
import { guardTransportEntry, readTransportOwner, stageTransportBinding } from './transport-owner.js';
import { runTransportNative } from './transport-native.js';
import { transportHash, transportFileHash, readRawFile, rawFileMatches, atomicTransportWrite, withTransportLock, assertTransportQuiescent, syncTransportDirectory } from './transport-files.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().refine(path.isAbsolute);
const optionsSchema = z.object({ dataDir: absolute, database: absolute, configDir: absolute, operationDir: absolute, binary: absolute, binarySha256: hex,
  tenantId: z.number().int().positive(), kbId: z.string().min(1), ownerId: z.string().min(1), modelId: z.string().min(1),
  operationId: z.string().regex(/^[A-Za-z0-9_.:@+-]{1,200}$/), compatibilityReceipt: hex,
  ownership: z.object({ issuer: z.string(), serviceId: z.string(), actorId: z.string(), accountId: z.string() }).strict(), stoppedPids: z.array(z.number().int().positive()).default([]),
  isolatedCopy: z.object({ sourceDatabase: absolute, sourceSha256: hex }).strict().optional() });
const fail = (code = 'transport_coordinator_rejected') => { throw new Error(code); };
const withoutBytes = ({ bytes: _bytes, ...rest }) => rest;
const unchangedPreview = (preview) => { const { databaseIdentity: _path, digest: _digest, ...stable } = preview; return stable; };
const fixedFiles = ['model-configuration.json', 'model-bootstrap/secrets.json', 'model-bootstrap/master.key', 'embedded-knowledge/secrets.json',
  'platform-account-sessions.json', 'settings.json', 'preferences.json', 'knowledge-library/documents.json', 'knowledge-library/libraries.json', 'conversation-memory/state.json'];
const privateDirectory = async (directory) => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.mode & 0o077) fail('transport_private_directory_required');
};
const syncFile = async (file) => { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } };

/** Explicit stopped-state maintenance. This module never starts a server or performs inference. */
export function createTransportCoordinator(input, { native = runTransportNative, checkpoint = async () => {}, guardEntry = () => {} } = {}) {
  const options = optionsSchema.parse(input); const { dataDir, database, configDir, operationDir } = options;
  if (database !== path.join(dataDir, 'embedded-knowledge', 'embedded-knowledge.db') || operationDir === dataDir || operationDir.startsWith(`${dataDir}${path.sep}`)) fail();
  const configFile = path.join(dataDir, 'model-configuration.json'); const journalFile = path.join(operationDir, 'journal.json');
  const contractDigest = transportHash(JSON.stringify(options));
  const guard = () => { guardTransportEntry(input.enterpriseOptions); guardEntry(); };
  if (!options.stoppedPids.length && !options.isolatedCopy) fail('transport_stop_evidence_required');
  const checkIsolation = async () => {
    if (!options.isolatedCopy) return;
    if (await fs.realpath(options.isolatedCopy.sourceDatabase) === await fs.realpath(database)
      || await transportFileHash(options.isolatedCopy.sourceDatabase) !== options.isolatedCopy.sourceSha256) fail('transport_copy_attestation_changed');
  };
  const quiescent = (file = database) => assertTransportQuiescent({ database: file, stoppedPids: options.stoppedPids });
  const ownerOptions = { dataDir, ownership: options.ownership, env: input.env, enterpriseOptions: input.enterpriseOptions };
  const readOwner = () => readTransportOwner(ownerOptions);
  const rawFiles = async (storageId) => {
    const names = [...fixedFiles, `account-key-activation/${storageId}.json`]; const result = [];
    for (const name of names) result.push({ name, ...withoutBytes(await readRawFile(path.join(dataDir, name))) });
    return result;
  };
  const checkFiles = async (files, stagedHash, allowStaged = false) => {
    for (const file of files) {
      const observed = await readRawFile(path.join(dataDir, file.name));
      if (allowStaged && file.name === 'model-configuration.json' && observed.exists && observed.sha256 === stagedHash && observed.mode === file.mode) continue;
      if (!rawFileMatches(observed, file)) fail('transport_file_conflict');
    }
  };
  const execute = async (request, owner) => {
    guard(); await quiescent(request.database);
    // Destination validation happens in readTransportOwner before the secret crosses this pipe.
    if (owner.binding.apiKey !== (await readOwner()).binding.apiKey) fail('transport_credential_changed');
    const secrets = JSON.parse((await fs.readFile(path.join(dataDir, 'embedded-knowledge/secrets.json'))).toString('utf8'));
    if (!z.string().length(32).safeParse(secrets.systemAesKey).success) fail();
    return native({ binary: options.binary, binarySha256: options.binarySha256, configDir, systemAesKey: secrets.systemAesKey, request });
  };
  const scope = { database, configDir, tenantId: options.tenantId, kbId: options.kbId, ownerId: options.ownerId, modelId: options.modelId,
    operationId: options.operationId, catalogDigest: '', backupReceipt: { sha256: '', restored: false, baselineDigest: '' }, stoppedReceipt: { stopped: false, evidenceDigest: '' } };
  const inspect = async () => {
    guard(); await checkIsolation(); const stopped = await quiescent();
    if (options.isolatedCopy && await transportFileHash(database) !== options.isolatedCopy.sourceSha256) fail('transport_copy_attestation_changed'); const owner = await readOwner(); const files = await rawFiles(owner.storageId);
    const first = await execute({ ...scope, mode: 'snapshot' }, owner);
    if (first.status !== 'private-snapshot' || !first.snapshot?.model?.parameters) fail();
    const targetParameters = knowledgeModelParameters('embedding', owner.binding, first.snapshot.model.parameters);
    const response = await execute({ ...scope, mode: 'snapshot', targetParameters }, owner);
    if (response.status !== 'private-snapshot') fail();
    const plan = planHyTransportRebind({ ...response.snapshot, tenantId: options.tenantId, kbId: options.kbId, oldIdentity: response.preview.current, targetIdentity: response.preview.target });
    if (plan.expectedLedgerDigest !== response.preview.ledgerDigest || plan.expectedSourceNodesDigest !== response.preview.sourceNodesDigest
      || !plan.selectedNodes.length || !plan.ledgerMutations.length) fail('transport_snapshot_mismatch');
    await checkFiles(files); await quiescent();
    const digest = transportHash(JSON.stringify({ contractDigest, files, preview: response.preview, plan }));
    return { owner, files, stopped, targetParameters, response, plan, digest };
  };
  const receipt = (journal) => ({ operationId: options.operationId, phase: journal.phase, digest: journal.digest,
    copied: journal.copied ?? journal.counts.selected, counts: journal.counts, backupSha256: journal.backup.sha256,
    configurationSha256: journal.stagedHash, databaseSha256: journal.postDatabaseHash ?? null });
  const writeJournal = (journal) => atomicTransportWrite(journalFile, Buffer.from(JSON.stringify(journal, null, 2)));
  const readJournal = async () => {
    const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
    if (journal.version !== 1 || journal.contractDigest !== contractDigest || !['prepared', 'database_committed', 'configuration_committed', 'verified', 'rolling_back', 'rolled_back'].includes(journal.phase)) fail('transport_journal_mismatch');
    return journal;
  };
  const locked = async (task) => {
    guard(); await checkIsolation(); await quiescent();
    return withTransportLock(path.join(operationDir, 'operator.lock'), () => withTransportLock(`${configFile}.lock`, task));
  };
  const requestFor = async (journal) => {
    const owner = await readOwner();
    if (owner.record.keyFingerprint !== journal.keyFingerprint || owner.storageId !== journal.storageId) fail('transport_credential_changed');
    return { owner, request: { ...journal.request, targetParameters: { ...journal.request.targetParameters, api_key: owner.binding.apiKey } } };
  };
  const checkStaged = async (journal) => {
    const staged = await readRawFile(path.join(operationDir, 'stage/model-configuration.json'));
    if (!staged.exists || staged.sha256 !== journal.stagedHash) fail('transport_staged_config_changed');
    return staged.bytes;
  };
  return {
    async preview() {
      const found = await inspect();
      return { status: 'preview', digest: found.digest, native: found.response.preview, counts: found.plan.beforeAfterCounts };
    },
    async prepare({ expectedDigest }) {
      hex.parse(expectedDigest); const found = await inspect(); if (found.digest !== expectedDigest) fail('transport_preview_changed');
      // An existing operation is resumed explicitly; preparation never overwrites backups.
      await fs.mkdir(operationDir, { mode: 0o700 }); await privateDirectory(operationDir);
      return locked(async () => {
        await checkFiles(found.files); const backupDir = path.join(operationDir, 'backup'); const restoredDir = path.join(operationDir, 'restored');
        await privateDirectory(backupDir); await privateDirectory(restoredDir); await privateDirectory(path.join(operationDir, 'stage'));
        const baselineHash = await transportFileHash(database); const databaseMode = (await fs.lstat(database)).mode & 0o777;
        const backupDatabase = path.join(backupDir, 'database.db'); const restoredDatabase = path.join(restoredDir, 'database.db');
        await fs.copyFile(database, backupDatabase, fs.constants.COPYFILE_EXCL); await fs.chmod(backupDatabase, databaseMode); await syncFile(backupDatabase);
        if (await transportFileHash(backupDatabase) !== baselineHash || await transportFileHash(database) !== baselineHash) fail('transport_backup_changed');
        for (const file of found.files) {
          if (!file.exists) continue;
          const source = await readRawFile(path.join(dataDir, file.name)); if (!rawFileMatches(source, file)) fail('transport_file_conflict');
          for (const directory of [backupDir, restoredDir]) {
            const destination = path.join(directory, file.name); await privateDirectory(path.dirname(destination));
            await atomicTransportWrite(destination, source.bytes, file.mode);
            if (!rawFileMatches(await readRawFile(destination), file)) fail('transport_restore_failed');
          }
        }
        await fs.copyFile(backupDatabase, restoredDatabase, fs.constants.COPYFILE_EXCL); await fs.chmod(restoredDatabase, databaseMode); await syncFile(restoredDatabase);
        if (await transportFileHash(restoredDatabase) !== baselineHash) fail('transport_restore_failed');
        const restore = await execute({ ...scope, database: restoredDatabase, mode: 'snapshot', targetParameters: found.targetParameters, catalogDigest: found.response.preview.catalogDigest }, found.owner);
        if (restore.status !== 'private-snapshot' || !isDeepStrictEqual(unchangedPreview(restore.preview), unchangedPreview(found.response.preview))) fail('transport_restore_failed');
        const staged = await stageTransportBinding({ owner: found.owner, stageDir: path.join(operationDir, 'stage'), enterpriseOptions: input.enterpriseOptions, env: input.env });
        await checkFiles(found.files); await quiescent(); if (await transportFileHash(database) !== baselineHash) fail('transport_database_changed');
        const backup = { sha256: transportHash(JSON.stringify({ baselineHash, databaseMode, files: found.files, restoredDatabaseHash: baselineHash, restoredStablePreview: unchangedPreview(restore.preview) })),
          databaseHash: baselineHash, databaseMode, restoredStablePreview: unchangedPreview(restore.preview) };
        const { api_key: _key, ...safeTarget } = found.targetParameters;
        const journal = { version: 1, phase: 'prepared', contractDigest, digest: found.digest, storageId: found.owner.storageId, keyFingerprint: found.owner.record.keyFingerprint,
          files: found.files, stagedHash: transportHash(staged), counts: found.plan.beforeAfterCounts, backup,
          request: { ...scope, targetParameters: safeTarget, catalogDigest: found.response.preview.catalogDigest, expected: found.response.preview,
            compatibilityReceipt: options.compatibilityReceipt, backupReceipt: { sha256: backup.sha256, restored: true, baselineDigest: found.response.preview.digest },
            stoppedReceipt: found.stopped, selectedNodes: found.plan.selectedNodes, ledgerMutations: found.plan.ledgerMutations } };
        await syncTransportDirectory(backupDir); await syncTransportDirectory(restoredDir); await writeJournal(journal); return receipt(journal);
      });
    },
    async resume() {
      return locked(async () => {
        const journal = await readJournal(); if (['rolling_back', 'rolled_back'].includes(journal.phase)) fail('transport_already_rolled_back');
        const staged = await checkStaged(journal); await checkFiles(journal.files, journal.stagedHash, journal.phase !== 'prepared');
        const { owner, request } = await requestFor(journal);
        if (journal.phase === 'prepared') {
          const applied = await execute({ ...request, mode: 'apply' }, owner);
          if (!['applied', 'already-applied'].includes(applied.status) || applied.copied !== journal.counts.selected || applied.revision !== request.expected.ledgerRevision + 1) fail('transport_native_receipt_invalid');
          await checkpoint('after_database_commit');
          await quiescent(); journal.postDatabaseHash = await transportFileHash(database); journal.copied = applied.copied; journal.phase = 'database_committed'; await writeJournal(journal);
        }
        if (await transportFileHash(database) !== journal.postDatabaseHash) fail('transport_database_changed');
        const verified = await execute({ ...request, mode: 'verify' }, owner); if (verified.status !== 'verified' || verified.copied !== journal.counts.selected) fail('transport_native_receipt_invalid');
        if (journal.phase === 'database_committed') {
          guard(); await quiescent(); await checkFiles(journal.files, journal.stagedHash, true);
          const original = journal.files.find((f) => f.name === 'model-configuration.json');
          const current = await readRawFile(configFile);
          if (current.sha256 !== journal.stagedHash) {
            await checkpoint('before_configuration_rename'); guard(); await checkFiles(journal.files); await requestFor(journal);
            await atomicTransportWrite(configFile, staged, original.mode, original); await checkpoint('after_configuration_rename');
          }
          journal.phase = 'configuration_committed'; await writeJournal(journal);
        }
        guard(); await quiescent(); await checkFiles(journal.files, journal.stagedHash, true);
        if ((await readRawFile(configFile)).sha256 !== journal.stagedHash || await transportFileHash(database) !== journal.postDatabaseHash) fail('transport_post_state_changed');
        journal.phase = 'verified'; await writeJournal(journal); return receipt(journal);
      });
    },
    async rollback() {
      return locked(async () => {
        const journal = await readJournal();
        if (journal.phase === 'rolled_back') {
          await checkFiles(journal.files); if (await transportFileHash(database) !== journal.backup.databaseHash) fail('transport_post_state_changed'); return receipt(journal);
        }
        await checkFiles(journal.files, journal.stagedHash, true);
        const actualHash = await transportFileHash(database);
        if (journal.phase !== 'rolling_back' && actualHash !== journal.backup.databaseHash) {
          const { owner, request } = await requestFor(journal);
          const verification = await execute({ ...request, mode: 'verify' }, owner); if (verification.status !== 'verified') fail();
          if (journal.postDatabaseHash && actualHash !== journal.postDatabaseHash) fail('transport_database_changed');
          journal.postDatabaseHash = actualHash;
        }
        if (![journal.backup.databaseHash, journal.postDatabaseHash].includes(actualHash)) fail('transport_database_changed');
        const backupDatabase = path.join(operationDir, 'backup/database.db');
        if (await transportFileHash(backupDatabase) !== journal.backup.databaseHash) fail('transport_backup_changed');
        for (const file of journal.files) if (file.exists && !rawFileMatches(await readRawFile(path.join(operationDir, 'backup', file.name)), file)) fail('transport_backup_changed');
        journal.phase = 'rolling_back'; await writeJournal(journal);
        if (actualHash !== journal.backup.databaseHash) {
          const temporary = `${database}.transport-restore`;
          try { await fs.copyFile(backupDatabase, temporary, fs.constants.COPYFILE_EXCL); }
          catch (error) { if (error.code !== 'EEXIST' || await transportFileHash(temporary) !== journal.backup.databaseHash) fail('transport_restore_conflict'); }
          await fs.chmod(temporary, journal.backup.databaseMode); await syncFile(temporary);
          if (await transportFileHash(database) !== actualHash || await transportFileHash(temporary) !== journal.backup.databaseHash) fail('transport_database_changed');
          await fs.rename(temporary, database); await syncTransportDirectory(path.dirname(database));
        }
        const original = journal.files.find((file) => file.name === 'model-configuration.json');
        if (!rawFileMatches(await readRawFile(configFile), original)) {
          const before = await readRawFile(configFile); if (before.sha256 !== journal.stagedHash) fail('transport_file_conflict');
          await atomicTransportWrite(configFile, (await readRawFile(path.join(operationDir, 'backup/model-configuration.json'))).bytes, original.mode, before);
        }
        await checkFiles(journal.files); await quiescent(); if (await transportFileHash(database) !== journal.backup.databaseHash) fail('transport_restore_failed');
        journal.phase = 'rolled_back'; await writeJournal(journal); return receipt(journal);
      });
    },
  };
}
