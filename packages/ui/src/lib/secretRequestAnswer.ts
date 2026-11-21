import { z } from 'zod';

import { runtimeFetch } from './runtime-fetch';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });
const fieldsSchema = z.object({
    fields: z.array(z.string()),
    reused: z.array(z.string()).catch([]),
});

const readError = async (response: Response, fallback: string) => {
    const payload = errorSchema.parse(await response.json().catch(() => null));
    throw new Error(payload.error || `${fallback} (${response.status})`);
};

export async function answerSecretRequest(
    input: { sessionId: string; callId: string; value: string } | { sessionId: string; callId: string; declined: true }
      | { sessionId: string; callId: string; values: Record<string, string>; remember: string[] },
    directory?: string,
): Promise<void> {
    const response = await runtimeFetch('/api/openchamber/secret/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        directory,
        body: JSON.stringify(input),
    });
    if (response.ok) return;
    await readError(response, 'The secret answer was not delivered');
}

export async function readSecretRunFields(
    input: { sessionId: string; callId: string },
    directory?: string,
): Promise<{ fields: string[]; reused: string[] } | null> {
    const response = await runtimeFetch('/api/openchamber/secret/fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        directory,
        body: JSON.stringify(input),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        await readError(response, 'The secret fields were not available');
    }
    return fieldsSchema.parse(await response.json());
}
