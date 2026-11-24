import { randomUUID } from 'node:crypto';
import { isRecord, isString } from '../shared/guards.js';
import { runCommand } from '../spaces/run-command.js';
import { OpenChamberControlError, controlErrorFields } from './error.js';
import { SECRET_ENV_NAME, SECRET_RUN_MAX_VALUE_LENGTH } from './secret-store.js';
const SECRET_RUN_MAX_INPUTS = 8;
const SECRET_RUN_MAX_REASON_LENGTH = 1000;
const SECRET_RUN_MAX_LABEL_LENGTH = 120;
const SECRET_RUN_MAX_PLACEHOLDER_LENGTH = 80;
const SECRET_RUN_DEFAULT_TIMEOUT_MS = 120_000;
const SECRET_RUN_MAX_TIMEOUT_MS = 600_000;
export const SECRET_LEASE_MS = 10 * 60_000;
const CAPTURE_BYTES = 1024 * 1024;
const OUTPUT_LIMIT = 32_000;
const RAN_NOTE = "The command ran once, with the secrets in its environment. In stdout and stderr every secret value is replaced by [secret:NAME]. Fix a failing command and call secret.run again; the env names in remembered are reused without asking the user while they last. Saved secrets require the user to confirm the command on a new card.";
const DECLINED_NOTE = "The user declined to give the secrets, so the command did not run. Continue without it or say what it blocks; ask again only if they want to.";
const CHAT_SENT_EARLIER_NOTE = "The card did not wait and the command did not run: the user had already written in the chat before it appeared, and that message follows this result. Continue from that message; call again only if it still fits.";
export function secretRunCommandLine(program, args) {
    const hidden = (code) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x61c
        || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)
        || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff;
    const visible = (value) => Array.from(value, (char) => {
        const code = char.codePointAt(0) ?? 0;
        return hidden(code) ? `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}` : char;
    }).join('');
    const word = (value) => (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(value) ? value : `'${visible(value).replaceAll("'", "'\\''")}'`);
    return [program, ...args].map(word).join(' ');
}
function secretRunCommand(input) {
    const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
    const program = isText(input?.program) ? input.program.trim() : '';
    if (!program)
        return { error: 'program is required: the executable to run, by name on PATH or by absolute path. It runs without a shell; for a script pass program "sh" (or "bash") with args ["-c", "<script>"]' };
    const args = input?.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || !args.every(isText))
        return { error: 'args must be an array of strings' };
    if (args.length > 64)
        return { error: `args has ${args.length} entries; the limit is 64` };
    const length = program.length + args.reduce((total, arg) => total + arg.length + 1, 0);
    if (length > 32000)
        return { error: `The command is ${length} characters; the limit is 32000. Put a long script in a file and run that` };
    return { program, args };
}
const isText = (value) => isString(value);
const isInteger = (value) => Number.isInteger(value);
const isValues = (value) => isRecord(value);
const readText = (value) => (isText(value) ? value.trim() : '');
const refuse = (message) => new OpenChamberControlError(message, 400);
const normalizeSecretRun = (input = {}) => {
    const command = secretRunCommand(input);
    if (command.program === undefined)
        throw refuse(command.error);
    const reason = readText(input.reason);
    if (!reason)
        throw refuse('reason is required: in the user\'s language, what the command does with the secrets');
    if (reason.length > SECRET_RUN_MAX_REASON_LENGTH)
        throw refuse(`reason is ${reason.length} characters; the limit is ${SECRET_RUN_MAX_REASON_LENGTH}`);
    if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
        throw refuse('inputs is required: one { env, label } per secret the command reads from its environment');
    }
    if (input.inputs.length > SECRET_RUN_MAX_INPUTS)
        throw refuse(`inputs has ${input.inputs.length} entries; the limit is ${SECRET_RUN_MAX_INPUTS}`);
    const seen = new Set();
    const inputs = input.inputs.map((entry, index) => {
        const env = readText(entry?.env);
        const label = readText(entry?.label);
        const placeholder = readText(entry?.placeholder);
        if (!SECRET_ENV_NAME.test(env))
            throw refuse(`inputs[${index}].env must be an environment variable name such as API_TOKEN`);
        if (seen.has(env))
            throw refuse(`inputs[${index}].env ${env} appears twice`);
        seen.add(env);
        if (!label)
            throw refuse(`inputs[${index}].label is required: what the secret is, shown above its field`);
        if (label.length > SECRET_RUN_MAX_LABEL_LENGTH)
            throw refuse(`inputs[${index}].label is ${label.length} characters; the limit is ${SECRET_RUN_MAX_LABEL_LENGTH}`);
        if (placeholder.length > SECRET_RUN_MAX_PLACEHOLDER_LENGTH)
            throw refuse(`inputs[${index}].placeholder is ${placeholder.length} characters; the limit is ${SECRET_RUN_MAX_PLACEHOLDER_LENGTH}`);
        return { env, label, placeholder };
    });
    let timeoutMs = SECRET_RUN_DEFAULT_TIMEOUT_MS;
    if (input.timeoutMs !== undefined) {
        if (!isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SECRET_RUN_MAX_TIMEOUT_MS) {
            throw refuse(`timeoutMs must be a whole number of milliseconds from 1 to ${SECRET_RUN_MAX_TIMEOUT_MS}`);
        }
        timeoutMs = input.timeoutMs;
    }
    return { ...command, reason, inputs, timeoutMs };
};
export const createSecretLeases = ({ now = Date.now, leaseMs = SECRET_LEASE_MS } = {}) => {
    const leases = new Map();
    const key = (sessionId, env) => `${sessionId}\u0000${env}`;
    const drop = (entryKey) => {
        const lease = leases.get(entryKey);
        if (!lease)
            return;
        clearTimeout(lease.timer);
        leases.delete(entryKey);
    };
    const read = (sessionId, env) => {
        const lease = leases.get(key(sessionId, env));
        if (!lease)
            return null;
        if (lease.expiresAt <= now()) {
            drop(key(sessionId, env));
            return null;
        }
        return lease.value;
    };
    const keep = (sessionId, env, value) => {
        const entryKey = key(sessionId, env);
        drop(entryKey);
        const timer = setTimeout(() => leases.delete(entryKey), leaseMs);
        timer.unref?.();
        leases.set(entryKey, { value, expiresAt: now() + leaseMs, timer });
    };
    const forget = (sessionId) => {
        let count = 0;
        for (const entryKey of [...leases.keys()]) {
            if (!entryKey.startsWith(key(sessionId, '')))
                continue;
            drop(entryKey);
            count += 1;
        }
        return count;
    };
    return { read, keep, forget };
};
const NUL = String.fromCharCode(0);
const prefixFunction = (text) => {
    const prefix = new Array(text.length).fill(0);
    for (let index = 1; index < text.length; index += 1) {
        let length = prefix[index - 1] ?? 0;
        while (length > 0 && text[index] !== text[length])
            length = prefix[length - 1] ?? 0;
        if (text[index] === text[length])
            length += 1;
        prefix[index] = length;
    }
    return prefix;
};
const occurrencesOf = (value, text) => {
    const prefix = prefixFunction(value);
    const ranges = [];
    let length = 0;
    for (let index = 0; index < text.length; index += 1) {
        while (length > 0 && text[index] !== value[length])
            length = prefix[length - 1] ?? 0;
        if (text[index] === value[length])
            length += 1;
        if (length === value.length) {
            ranges.push([index - value.length + 1, index + 1]);
            length = prefix[length - 1] ?? 0;
        }
    }
    return ranges;
};
const leadingTailOf = (value, text) => {
    const prefix = prefixFunction(`${text.slice(0, value.length)}${NUL}${value}`);
    return prefix[prefix.length - 1] ?? 0;
};
export const redactSecrets = (text, values, { cutAtStart = false } = {}) => {
    const owner = new Array(text.length).fill(null);
    const entries = Object.entries(values).filter(([, value]) => value.length > 0).sort(([, a], [, b]) => b.length - a.length);
    for (const [env, value] of entries) {
        const ranges = occurrencesOf(value, text);
        if (cutAtStart)
            ranges.push([0, leadingTailOf(value, text)]);
        const depth = new Int32Array(text.length + 1);
        for (const [start, end] of ranges) {
            depth[start] = (depth[start] ?? 0) + 1;
            depth[end] = (depth[end] ?? 0) - 1;
        }
        let open = 0;
        for (let index = 0; index < text.length; index += 1) {
            open += depth[index] ?? 0;
            if (open > 0 && owner[index] === null)
                owner[index] = env;
        }
    }
    const pieces = [];
    let shown = 0;
    for (let index = 0; index < text.length; index += 1) {
        const env = owner[index];
        if (env === null || owner[index - 1] === env)
            continue;
        pieces.push(text.slice(shown, index), `[secret:${env}]`);
        shown = index;
        while (shown < text.length && owner[shown] === env)
            shown += 1;
        index = shown - 1;
    }
    pieces.push(text.slice(shown));
    return pieces.join('');
};
const shownOutput = (raw, values) => {
    if (Buffer.byteLength(raw, 'utf8') < CAPTURE_BYTES - 3)
        return lastChars(redactSecrets(raw, values));
    let start = 0;
    while (raw.charCodeAt(start) === 0xfffd)
        start += 1;
    return { ...lastChars(redactSecrets(raw.slice(start), values, { cutAtStart: true })), truncated: true };
};
const lastChars = (text) => (text.length > OUTPUT_LIMIT ? { text: text.slice(-OUTPUT_LIMIT), truncated: true } : { text, truncated: false });
const runOnce = async ({ program, args, timeoutMs }, { values, directory, signal, run }) => {
    try {
        const { code, stdout, stderr } = await run(program, args, {
            cwd: directory,
            env: { ...process.env, ...values },
            timeoutMs,
            signal,
            killTree: true,
            keepTail: true,
            maxOutputBytes: CAPTURE_BYTES,
        });
        return { outcome: 'exited', exitCode: code, stdout, stderr };
    }
    catch (error) {
        if (signal?.aborted)
            throw new OpenChamberControlError('The call stopped while the command was running, and the command was stopped', 499);
        const outcome = controlErrorFields(error)?.code === 'command_timeout' ? 'timeout'
            : controlErrorFields(error)?.code === 'command_spawn_failed' ? 'not-started'
                : 'killed';
        return { outcome, exitCode: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) };
    }
};
const ownValue = (record, env) => Object.hasOwn(record, env) ? record[env] : undefined;
const savedSnapshot = (entries) => Object.fromEntries(Object.entries(entries).map(
    ([env, { scope, revision }]) => [env, { scope, revision }],
));
const staleConsent = () => new OpenChamberControlError('The project or saved secrets changed. Decline this card and ask the agent to try again.', 409);

export const createSecretRuns = ({
    waits, hasUnreadChat, leases = createSecretLeases(), run = runCommand,
    savedStore, projectForDirectory, resolveSessionDirectory,
}) => {
    const pending = new Map();
    const key = (sessionId, callId) => `${sessionId}\u0000${callId}`;
    const execute = async (input, { sessionId, callId, directory, signal, authorized }) => {
        if (!authorized)
            throw new OpenChamberControlError('secret.run is only available to agents, through the openchamber_secret tool', 403);
        const request = normalizeSecretRun(input);
        if (!sessionId || !callId)
            throw new OpenChamberControlError('This connection cannot wait for a secret', 400);
        if (!directory)
            throw new OpenChamberControlError('This session has no directory to run the command in', 400);
        const values = Object.create(null);
        const missing = [];
        for (const field of request.inputs) {
            const value = leases.read(sessionId, field.env);
            if (value === null)
                missing.push(field);
            else
                values[field.env] = value;
        }
        const reused = Object.keys(values);
        const fields = missing.map((field) => field.env);
        let persistence = null;
        if (fields.length && savedStore && projectForDirectory && resolveSessionDirectory) {
            try {
                const project = await projectForDirectory(directory);
                const stored = savedStore.read(project?.id ?? null, fields);
                persistence = { project, consent: randomUUID(), saved: savedSnapshot(stored) };
            } catch {
                // An unavailable store still allows a one-time or session answer.
            }
        }
        if (await hasUnreadChat(sessionId)) {
            return { answer: { answered: false, reason: 'chat-sent-earlier' }, note: CHAT_SENT_EARLIER_NOTE };
        }
        if (fields.length > 0) {
            const slotKey = key(sessionId, callId);
            if (pending.has(slotKey))
                throw new OpenChamberControlError('This call already waits for secrets', 409);
            const slot = { fields, reused, persistence, directory, signal, submission: null };
            pending.set(slotKey, slot);
            try {
                const title = missing.map((field) => field.label).join(', ').slice(0, SECRET_RUN_MAX_LABEL_LENGTH);
                const answer = await waits.wait({ sessionId, callId, title, directory, signal });
                if (answer.summary !== 'submitted' || !slot.submission)
                    return { answer: { status: 'declined' }, note: DECLINED_NOTE };
            } finally {
                pending.delete(slotKey);
            }
            if (signal?.aborted)
                throw new OpenChamberControlError('The card stopped waiting before the user answered', 499);
            Object.assign(values, slot.submission.values);
            for (const env of slot.submission.remember)
                leases.keep(sessionId, env, values[env]);
        }
        const result = await runOnce(request, { values, directory, signal, run });
        const stdout = shownOutput(result.stdout, values);
        const stderr = shownOutput(result.stderr, values);
        const remembered = request.inputs.map((field) => field.env).filter((env) => leases.read(sessionId, env) !== null);
        const data = {
            answer: { status: 'ran', outcome: result.outcome, exitCode: result.exitCode },
            stdout: stdout.text,
            stderr: stderr.text,
            remembered,
            note: RAN_NOTE,
        };
        if (stdout.truncated || stderr.truncated)
            data.truncated = { stdout: stdout.truncated, stderr: stderr.truncated };
        if (result.error)
            data.error = redactSecrets(result.error, values);
        return data;
    };
    const describe = ({ fields, reused, persistence }) => ({
        fields,
        reused,
        ...(persistence && {
            projectPath: persistence.project?.path ?? null,
            consent: persistence.consent,
            saved: Object.fromEntries(Object.entries(persistence.saved).map(([env, { scope }]) => [env, scope])),
        }),
    });
    const fieldsFor = (sessionId, callId) => {
        const slot = pending.get(key(sessionId, callId));
        return slot ? describe(slot) : null;
    };
    const assertWaiting = (sessionId, callId, slot) => {
        if (!slot || slot.signal?.aborted || slot.submission || pending.get(key(sessionId, callId)) !== slot)
            throw new OpenChamberControlError('This request is no longer waiting for a secret', 404);
    };
    const assertConsent = async (sessionId, callId, slot, consent) => {
        const persistence = slot.persistence;
        if (!persistence || !isText(consent) || consent !== persistence.consent)
            throw staleConsent();
        const directory = await resolveSessionDirectory(sessionId);
        if (directory !== slot.directory)
            throw staleConsent();
        const project = await projectForDirectory(directory);
        assertWaiting(sessionId, callId, slot);
        if (project?.id !== persistence.project?.id || consent !== persistence.consent)
            throw staleConsent();
    };
    const readCurrent = (slot) => {
        const { project, saved } = slot.persistence;
        const stored = savedStore.read(project?.id ?? null, slot.fields);
        for (const env of slot.fields) {
            const expected = ownValue(saved, env);
            const current = ownValue(stored, env);
            if (expected?.revision !== current?.revision || expected?.scope !== current?.scope)
                throw staleConsent();
        }
        return stored;
    };
    const submit = async (sessionId, callId, input, settle) => {
        const slot = pending.get(key(sessionId, callId));
        assertWaiting(sessionId, callId, slot);
        const raw = input.values;
        if (!isValues(raw))
            throw new OpenChamberControlError('values is required: one value per field', 400);
        const saved = slot.persistence?.saved ?? {};
        const typedFields = slot.fields.filter((env) => !Object.hasOwn(saved, env));
        const values = Object.create(null);
        for (const env of typedFields) {
            const value = ownValue(raw, env);
            if (!isText(value) || !value.trim())
                throw new OpenChamberControlError(`A value for ${env} is required`, 400);
            if (value.length > SECRET_RUN_MAX_VALUE_LENGTH)
                throw new OpenChamberControlError(`The value for ${env} is ${value.length} characters; the limit is ${SECRET_RUN_MAX_VALUE_LENGTH}`, 413);
            if (value.includes(NUL))
                throw new OpenChamberControlError(`The value for ${env} contains a NUL character`, 400);
            values[env] = value;
        }
        if (Object.keys(raw).some((env) => !Object.hasOwn(values, env)))
            throw new OpenChamberControlError('The answer contains a value this card did not request', 400);
        const remember = Array.isArray(input.remember) ? [...new Set(input.remember.filter((env) => typedFields.includes(env)))] : [];
        const save = input.save ?? [];
        const saveGlobally = input.saveGlobally ?? [];
        if (![save, saveGlobally].every((list) => Array.isArray(list) && list.every((env) => typedFields.includes(env)))
            || save.some((env) => saveGlobally.includes(env))
            || remember.some((env) => save.includes(env) || saveGlobally.includes(env)))
            throw new OpenChamberControlError('Choose one retention option per new secret', 400);
        if (save.length && !slot.persistence?.project)
            throw new OpenChamberControlError('This session is not in a configured project', 400);

        if (Object.keys(saved).length || save.length || saveGlobally.length) {
            await assertConsent(sessionId, callId, slot, input.consent);
            assertWaiting(sessionId, callId, slot);
            if (slot.persistence.consent !== input.consent) throw staleConsent();
            const current = readCurrent(slot);
            for (const [env, { value }] of Object.entries(current)) values[env] = value;
            const set = [
                ...[...new Set(save)].map((env) => ({ env, value: values[env], scope: 'project' })),
                ...[...new Set(saveGlobally)].map((env) => ({ env, value: values[env], scope: 'global' })),
            ];
            if (set.length) savedStore.update(slot.persistence.project?.id ?? null, { set });
        }
        slot.submission = { values, remember };
        settle(sessionId, callId, 'submitted', null);
        return { status: 'submitted' };
    };
    const forgetSaved = async (sessionId, callId, env, consent) => {
        const slot = pending.get(key(sessionId, callId));
        assertWaiting(sessionId, callId, slot);
        await assertConsent(sessionId, callId, slot, consent);
        assertWaiting(sessionId, callId, slot);
        if (slot.persistence.consent !== consent) throw staleConsent();
        const current = readCurrent(slot);
        const entry = ownValue(current, env);
        if (!entry)
            throw new OpenChamberControlError('This card has no saved value for that field', 400);
        const projectId = slot.persistence.project?.id ?? null;
        savedStore.update(projectId, { remove: { env, scope: entry.scope, revision: entry.revision } });
        slot.persistence.saved = savedSnapshot(savedStore.read(projectId, slot.fields));
        slot.persistence.consent = randomUUID();
        return describe(slot);
    };
    const forget = (sessionId) => {
        if (!sessionId)
            throw new OpenChamberControlError('secret.forget needs the calling session', 400);
        return { forgotten: leases.forget(sessionId) };
    };
    return { execute, fieldsFor, submit, forgetSaved, forget };
};
