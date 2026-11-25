import React from 'react';
import { z } from 'zod';

import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { leadI18n } from '@/lib/i18n/messages/lead.i18n';
import type { Session } from '@/lib/opencode/model';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { LEAD_REPLY_KEY, leadReplyText, type LeadReply } from '@/lib/sessionLead';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { createSession } from './session-actions';
import { useSessionUIStore } from './session-ui-store';

const endpoint = (id: string) => `/api/openchamber/sessions/${encodeURIComponent(id)}/lead`;
const errorSchema = z.object({ error: z.string() });
const capabilitySchema = z.object({ enabled: z.boolean() });
const briefSchema = z.object({ brief: z.string().nullable() });
const capabilities = new Map<string, Promise<boolean>>();

export function useLeadStrings() {
  const { locale } = useI18n();
  return leadI18n[locale];
}

export function useLeadAvailability(request = true) {
  const [available, setAvailable] = React.useState(false);
  React.useEffect(() => {
    if (!request || isVSCodeRuntime()) return;
    let current = true;
    const refresh = () => {
      const key = getRuntimeKey();
      setAvailable(false);
      let lookup = capabilities.get(key);
      if (!lookup) {
        lookup = runtimeFetch('/api/openchamber/sessions/lead-capability')
          .then(async (response) => response.ok && capabilitySchema.safeParse(await response.json()).data?.enabled === true)
          .catch(() => false);
        capabilities.set(key, lookup);
        void lookup.then(() => { if (capabilities.get(key) === lookup) capabilities.delete(key); });
      }
      void lookup.then((enabled) => { if (current && getRuntimeKey() === key) setAvailable(enabled); });
    };
    refresh();
    const unsubscribe = subscribeRuntimeEndpointChanged(refresh);
    return () => { current = false; unsubscribe(); };
  }, [request]);
  return request && available;
}

type LeadMutation = { action: 'mark' | 'unmark' | 'takeOver' } | { action: 'handover'; leadId: string };
export async function mutateLead(sessionId: string, directory: string, mutation: LeadMutation): Promise<void> {
  const response = await runtimeFetch(endpoint(sessionId), {
    method: 'POST', headers: { 'content-type': 'application/json' }, directory, body: JSON.stringify(mutation),
  });
  if (response.ok) return;
  const body = errorSchema.safeParse(await response.json().catch(() => null));
  throw new Error(body.data?.error ?? `Lead request failed (${response.status})`);
}

export async function createProjectLead(directory: string): Promise<void> {
  const current = captureRuntimeInstance();
  const session = await createSession(undefined, directory);
  if (!current()) return;
  if (!session) throw new Error('Could not create the session');
  await mutateLead(session.id, session.directory, { action: 'mark' });
}

export async function readLeadBrief(sessionId: string, directory: string, signal: AbortSignal): Promise<string | null> {
  const response = await runtimeFetch(endpoint(sessionId), { directory, signal });
  if (!response.ok) throw new Error(`Could not read the brief (${response.status})`);
  return briefSchema.parse(await response.json()).brief;
}

export async function sendLeadReply(session: Session, updatedAt: number, reply: LeadReply): Promise<void> {
  const runtimeKey = getRuntimeKey();
  const model = session.model;
  if (!model || !session.directory || isSpaceDirectory(session.directory)) throw new Error('The session model or directory is unavailable');
  let admitted = false;
  await useSessionUIStore.getState().sendMessage(
    leadReplyText(reply), model.providerID, model.id, session.agent,
    undefined, undefined, undefined, model.variant, 'normal', {
      target: { sessionId: session.id, directory: session.directory, runtimeKey },
      userInitiated: true,
      queuedGoal: null,
      metadata: { [LEAD_REPLY_KEY]: { updatedAt, ...reply } },
      onPromptAdmitted: () => { admitted = true; },
    },
  );
  if (!admitted) throw new Error('The reply was not admitted as a prompt');
}
