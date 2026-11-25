import { z } from 'zod';

import { runtimeFetch } from './runtime-fetch';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });
const fieldsSchema = z.object({
    fields: z.array(z.string()),
    reused: z.array(z.string()).catch([]),
    consent: z.string().min(1).optional(),
    projectPath: z.string().nullable().optional(),
    saved: z.record(z.string(), z.enum(['project', 'global'])).optional(),
});

export type SecretRunFields = z.infer<typeof fieldsSchema>;
type SecretCardIdentity = { sessionId: string; callId: string };
export type SecretRunAnswer = {
    values: Record<string, string>;
    remember: string[];
    consent?: string;
    save?: string[];
    saveGlobally?: string[];
};

const readError = async (response: Response, fallback: string) => {
    const payload = errorSchema.parse(await response.json().catch(() => null));
    throw new Error(payload.error || `${fallback} (${response.status})`);
};

const postSecretCard = (action: 'answer' | 'fields', input: SecretCardIdentity, directory?: string) => (
    runtimeFetch(`/api/openchamber/secret/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        directory,
        body: JSON.stringify(input),
    })
);

export async function answerSecretRequest(
    input: SecretCardIdentity & ({ value: string } | { declined: true } | SecretRunAnswer),
    directory?: string,
): Promise<void> {
    const response = await postSecretCard('answer', input, directory);
    if (response.ok) return;
    await readError(response, 'The secret answer was not delivered');
}

export async function readSecretRunFields(
    input: SecretCardIdentity,
    directory?: string,
): Promise<SecretRunFields | null> {
    const response = await postSecretCard('fields', input, directory);
    if (response.status === 404) return null;
    if (!response.ok) {
        await readError(response, 'The secret fields were not available');
    }
    return fieldsSchema.parse(await response.json());
}

export async function forgetSavedSecret(
    input: SecretCardIdentity & { forgetSaved: string; consent: string },
    directory?: string,
): Promise<SecretRunFields> {
    const response = await postSecretCard('answer', input, directory);
    if (!response.ok) await readError(response, 'The saved secret was not removed');
    return fieldsSchema.parse(await response.json());
}
