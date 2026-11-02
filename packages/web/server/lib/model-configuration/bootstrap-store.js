import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

const mode = 0o600;

const clone = (value) => structuredClone(value);
const fingerprint = (secret) => createHash('sha256').update(secret).digest('hex');
const isRecord = (value) => value !== null && Object(value) === value && !Array.isArray(value);
const isString = (value) => String(value) === value;

const writeJson = async (filePath, value) => {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx', mode);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
};

/**
 * Private operation state for model bootstrap. Public model configuration is
 * owned by runtime.js; this store only retains short lived discovery and
 * rollback metadata. Secrets are handed to the injected secret boundary and
 * never written to operation JSON.
 */
export const createModelBootstrapStore = ({ dataDir, secretStore, now = () => Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) => {
  if (!dataDir) throw new Error('Model bootstrap needs a data directory');
  const directory = path.join(dataDir, 'model-bootstrap');
  const secretFilePath = path.join(directory, 'secrets.json');
  const masterKeyPath = path.join(directory, 'master.key');
  let masterKeyPromise;
  let secretQueue = Promise.resolve();
  const withSecretLock = (task) => {
    const run = secretQueue.then(task, task);
    secretQueue = run.catch(() => {});
    return run;
  };
  const ensureDirectory = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  };
  const readSecretRecords = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(secretFilePath, 'utf8'));
      if (!isRecord(parsed)) throw new Error('invalid model bootstrap secret store');
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  };
  const getMasterKey = async () => {
    if (!masterKeyPromise) {
      masterKeyPromise = (async () => {
        await ensureDirectory();
        try {
          const current = await fs.readFile(masterKeyPath);
          if (current.length !== 32) throw new Error('invalid model bootstrap master key');
          return current;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          const generated = randomBytes(32);
          try {
            await fs.writeFile(masterKeyPath, generated, { flag: 'wx', mode });
            if (process.platform !== 'win32') await fs.chmod(masterKeyPath, mode);
            return generated;
          } catch (writeError) {
            if (writeError?.code !== 'EEXIST') throw writeError;
            const current = await fs.readFile(masterKeyPath);
            if (current.length !== 32) throw new Error('invalid model bootstrap master key');
            return current;
          }
        }
      })();
    }
    return masterKeyPromise;
  };
  const sealSecret = async (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await getMasterKey(), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
  };
  const openSecret = async (record) => {
    if (!isRecord(record) || !isString(record.iv) || !isString(record.tag) || !isString(record.data)) return null;
    const decipher = createDecipheriv('aes-256-gcm', await getMasterKey(), Buffer.from(record.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64url')), decipher.final()]).toString('utf8');
  };
  const secretPut = async (value) => {
    if (!value) return null;
    const ref = `model-bootstrap-${randomUUID()}`;
    if (secretStore?.put) await secretStore.put(ref, value);
    else if (secretStore?.set) await secretStore.set(ref, value);
    else if (secretStore) throw new Error('model bootstrap secret store cannot write');
    else await withSecretLock(async () => {
      const records = await readSecretRecords();
      records[ref] = await sealSecret(value);
      await writeJson(secretFilePath, records);
    });
    return { ref, fingerprint: fingerprint(value), last4: value.slice(-4) };
  };
  const secretGet = async (reference) => {
    if (!reference) return null;
    if (secretStore?.get) return secretStore.get(reference);
    if (secretStore) return null;
    return withSecretLock(async () => {
      try { return await openSecret((await readSecretRecords())[reference]); } catch { return null; }
    });
  };
  const secretDelete = async (reference) => {
    if (!reference) return;
    if (secretStore?.delete) await secretStore.delete(reference);
    else if (secretStore?.remove) await secretStore.remove(reference);
    else if (secretStore) return;
    else await withSecretLock(async () => {
      const records = await readSecretRecords();
      if (!Object.hasOwn(records, reference)) return;
      delete records[reference];
      await writeJson(secretFilePath, records);
    });
  };
  const filePath = (id) => path.join(directory, `${id}.json`);
  const create = async (record) => {
    await ensureDirectory();
    const id = record.id ?? randomUUID();
    const state = { ...clone(record), id, createdAt: record.createdAt ?? new Date().toISOString() };
    await writeJson(filePath(id), state);
    return clone(state);
  };
  const read = async (id) => {
    if (!id) return null;
    try {
      const raw = JSON.parse(await fs.readFile(filePath(id), 'utf8'));
      const createdAt = Date.parse(raw.createdAt);
      if (!Number.isFinite(createdAt) || createdAt + maxAgeMs <= now()) {
        await fs.unlink(filePath(id)).catch(() => {});
        if (raw.secretRef) await secretDelete(raw.secretRef);
        if (raw.durableSecretRef && raw.status !== 'applied') await secretDelete(raw.durableSecretRef);
        return null;
      }
      return clone(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const update = async (id, change) => {
    const current = await read(id);
    if (!current) return null;
    const next = change instanceof Function ? await change(clone(current)) : { ...current, ...clone(change) };
    await writeJson(filePath(id), next);
    return clone(next);
  };
  const remove = async (id) => {
    const current = await read(id);
    await fs.unlink(filePath(id)).catch(() => {});
    if (current?.secretRef) await secretDelete(current.secretRef);
    if (current?.durableSecretRef && current.status !== 'applied') await secretDelete(current.durableSecretRef);
    return current;
  };
  return { create, read, update, remove, putSecret: secretPut, getSecret: secretGet, deleteSecret: secretDelete, fingerprint };
};
