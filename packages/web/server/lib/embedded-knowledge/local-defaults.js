/**
 * Defaults inherited from a local WeKnora Lite installation.
 *
 * The bundled backend ships with DashScope text-embedding-v4 and (when the
 * binary links it) anydoc. Someone who already tuned a local WeKnora Lite
 * install usually has more: a vision model for image descriptions, an ASR
 * model, and PaddleOCR-VL Cloud for scanned PDFs. Those choices live in that
 * installation's SQLite database, with model credentials encrypted under its
 * own SYSTEM_AES_KEY.
 *
 * This module reads that database read-only, decrypts the credentials with the
 * key from the same installation's runtime.env, and returns them as plain
 * provisioning input. Nothing is written back to the other application, and a
 * machine without that installation simply gets `null`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

const require = createRequire(import.meta.url);

const LOCAL_ROOT = path.join(os.homedir(), '.weknora-lite');
const DEFAULT_DATABASE = path.join(LOCAL_ROOT, 'data', 'weknora.db');
const RUNTIME_ENV = path.join(LOCAL_ROOT, 'runtime.env');
const ENC_PREFIX = 'enc:v1:';

const PDF_IMAGE_TYPES = ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'tiff'];
// Formats anydoc converts without OCR.
const ANYDOC_TYPES = ['doc', 'docm', 'docx', 'xls', 'xlsm', 'xlsx', 'ppt', 'pptm', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub', 'csv'];

const loadSqlite = () => {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
};

const readAesKey = () => {
  try {
    const line = fs.readFileSync(RUNTIME_ENV, 'utf8').split('\n').find((entry) => entry.startsWith('SYSTEM_AES_KEY='));
    if (!line) return null;
    const key = line.slice('SYSTEM_AES_KEY='.length).trim();
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
};

const decryptSecret = (value, aesKey) => {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || !parsed.data.startsWith(ENC_PREFIX) || !aesKey) return value;
  try {
    const raw = Buffer.from(parsed.data.slice(ENC_PREFIX.length), 'base64url');
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const encrypted = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKey, 'utf8'), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return value;
  }
};

const asText = (value) => {
  const parsed = z.string().safeParse(value);
  if (parsed.success) return parsed.data;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return value ? String(value) : null;
};

const parseJson = (value) => {
  const text = asText(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const hostOf = (parameters) => {
  try {
    return new URL(parameters?.base_url).hostname;
  } catch {
    return null;
  }
};

const pickModel = (models, type, preferredName) => {
  const candidates = models.filter((model) => model.type === type);
  const preferred = preferredName ? candidates.find((model) => model.name === preferredName) : null;
  return preferred ?? candidates[0] ?? null;
};

const toModel = (row, aesKey) => {
  const parameters = parseJson(row.parameters) ?? {};
  if (parameters.api_key) parameters.api_key = decryptSecret(parameters.api_key, aesKey);
  return {
    name: row.name,
    type: row.type,
    displayName: row.display_name || row.name,
    parameters,
  };
};

const pickTemplateKnowledgeBase = (rows) => {
  const withRules = rows
    .map((row) => ({ ...row, chunking: parseJson(row.chunking_config) }))
    .filter((row) => Array.isArray(row.chunking?.parser_engine_rules) && row.chunking.parser_engine_rules.length > 0);
  const tuned = withRules.filter((row) => Number(row.chunking.chunk_size) > 0);
  return tuned[0] ?? withRules[0] ?? null;
};

let cache = null;
let cachedPath = null;

/**
 * Returns the local installation's model and parser choices, or null when it
 * cannot be read. Never throws: provisioning treats this as an optional
 * enhancement.
 */
export const readLocalDefaults = ({ databasePath = process.env.OPENCHAMBER_EMBEDDED_KNOWLEDGE_IMPORT_DB || DEFAULT_DATABASE } = {}) => {
  if (cache && cachedPath === databasePath) return cache;
  cache = null;
  cachedPath = databasePath;

  try {
    if (!fs.existsSync(databasePath)) return null;
    const sqlite = loadSqlite();
    if (!sqlite?.DatabaseSync) return null;

    const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const aesKey = readAesKey();
      const modelRows = db
        .prepare('select name, display_name, type, parameters from models where deleted_at is null')
        .all();
      const models = modelRows.map((row) => toModel(row, aesKey));

      const parserRow = db
        .prepare(
          "select parser_engine_config from tenants where parser_engine_config is not null and parser_engine_config <> '' order by id desc limit 1",
        )
        .get();
      const parser = parseJson(parserRow?.parser_engine_config);
      if (parser?.paddleocr_vl_cloud_token) {
        parser.paddleocr_vl_cloud_token = decryptSecret(parser.paddleocr_vl_cloud_token, aesKey);
      }

      const kbRows = db
        .prepare(
          'select name, chunking_config, image_processing_config, vlm_config, indexing_strategy from knowledge_bases where deleted_at is null',
        )
        .all();
      const template = pickTemplateKnowledgeBase(kbRows);

      // Image understanding prefers a working coding-plan Qwen (the user's
      // chat key also accepts images) over the VLLM record, which may be on a
      // free tier that has run out. The KB requires the model record to be of
      // type VLLM, so provisioning creates the copy under that type.
      const codingVision = models.find(
        (model) =>
          model.parameters?.supports_vision === true &&
          model.parameters?.api_key &&
          !String(model.parameters.api_key).startsWith(ENC_PREFIX) &&
          String(model.parameters.base_url || '').includes('coding.dashscope.aliyuncs.com'),
      );
      const selected = {
        embedding: pickModel(models, 'Embedding', 'text-embedding-v4'),
        rerank: pickModel(models, 'Rerank', 'qwen3-rerank'),
        vision: codingVision ?? pickModel(models, 'VLLM', 'qwen3.8-flash'),
        asr: pickModel(models, 'ASR', 'qwen3-asr-flash'),
      };

      // Everything the local installation configured, one record per
      // (name, type): the chat models and image embedding are not wired into
      // the library yet, but they are part of the setup and are imported.
      const importableModels = [];
      const seenModels = new Set();
      for (const row of models) {
        const key = `${row.type}:${row.name}`;
        if (seenModels.has(key)) continue;
        if (!row.parameters?.api_key || String(row.parameters.api_key).startsWith(ENC_PREFIX)) continue;
        seenModels.add(key);
        importableModels.push(row);
      }

      const hosts = [
        ...new Set(
          [...Object.values(selected), ...importableModels]
            .map((model) => hostOf(model?.parameters))
            .filter(Boolean),
        ),
      ];
      if (parser?.paddleocr_vl_cloud_token) hosts.push('paddleocr.aistudio-app.com');

      // A credential that stayed ciphertext means its key could not be read;
      // importing it would only make the backend call a provider with garbage.
      const usable = Object.entries(selected).filter(
        ([, model]) => model?.parameters?.api_key && !String(model.parameters.api_key).startsWith(ENC_PREFIX),
      );
      cache = {
        models: Object.fromEntries(usable),
        importableModels,
        parser: parser?.paddleocr_vl_cloud_token ? parser : null,
        knowledgeBase: template
          ? {
              chunking: template.chunking,
              imageProcessing: parseJson(template.image_processing_config),
              vlm: parseJson(template.vlm_config),
            }
          : null,
        hosts,
        pdfImageTypes: PDF_IMAGE_TYPES,
        anydocTypes: ANYDOC_TYPES,
      };
      return cache;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
};
