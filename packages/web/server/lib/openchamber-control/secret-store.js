import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { OpenChamberControlError } from './error.js';

export const SECRET_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const SECRET_RUN_MAX_VALUE_LENGTH = 16_000;

const entrySchema = z.object({
    projectId: z.string().min(1).nullable(),
    env: z.string().regex(SECRET_ENV_NAME),
    value: z.string().max(SECRET_RUN_MAX_VALUE_LENGTH).refine((value) => value.trim() && !value.includes('\0')),
    revision: z.uuid(),
});
const documentSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });
const unavailable = () => new OpenChamberControlError('Saved secrets are unavailable on this server', 503);

// One control service owns this file. The synchronous read and atomic replacement
// keep each mutation together, including updates from two open cards.
export const createSavedSecretStore = ({ filePath }) => {
    const readDocument = () => {
        try {
            return documentSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        } catch (error) {
            if (error?.code === 'ENOENT') return { version: 1, entries: [] };
            throw unavailable();
        }
    };

    const read = (projectId, names) => {
        const { entries } = readDocument();
        const matches = [];
        for (const env of names) {
            const project = projectId === null ? undefined : entries.find((entry) => entry.projectId === projectId && entry.env === env);
            const entry = project ?? entries.find((entry) => entry.projectId === null && entry.env === env);
            if (entry) matches.push([env, { scope: project ? 'project' : 'global', value: entry.value, revision: entry.revision }]);
        }
        return Object.fromEntries(matches);
    };

    const update = (projectId, { set = [], remove }) => {
        const document = readDocument();
        const targetProject = (scope) => {
            if (scope === 'global') return null;
            if (scope === 'project' && projectId) return projectId;
            throw new OpenChamberControlError('This session is not in a configured project', 400);
        };
        if (remove) {
            const id = targetProject(remove.scope);
            const index = document.entries.findIndex((entry) => entry.env === remove.env && entry.projectId === id && entry.revision === remove.revision);
            if (index < 0) throw new OpenChamberControlError('The saved secret changed while the card was open', 409);
            document.entries.splice(index, 1);
        }
        for (const { env, scope, value } of set) {
            const id = targetProject(scope);
            document.entries = document.entries.filter((entry) => entry.env !== env || entry.projectId !== id);
            document.entries.push({ projectId: id, env, value, revision: randomUUID() });
        }
        if (!documentSchema.safeParse(document).success) throw unavailable();
        const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
            fs.writeFileSync(temporaryPath, JSON.stringify(document), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(temporaryPath, filePath);
        } catch {
            try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the write error */ }
            throw unavailable();
        }
    };

    return { read, update };
};
