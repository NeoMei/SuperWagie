import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  isOpenCodeUpgradeSupported,
  resolveOpenCodeUpgradeStatusVersion,
} from './openCodeUpdateDedup';

/**
 * Transport for the OpenCode upgrade the update toast and About share. The
 * server owns the decision (`/api/opencode/upgrade-status`) and the install
 * (`/api/opencode/upgrade`); this module only parses their answers.
 */

const upgradeResponse = z.object({
  success: z.boolean().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

const runtimeUpdateSchema = z.object({
  status: z.enum(['idle', 'checking', 'downloading', 'current', 'installed', 'activating', 'failed']),
  latestVersion: z.string().nullable().optional(),
  installedVersion: z.string().nullable().optional(),
  packagedVersion: z.string().nullable().optional(),
  restartRequired: z.boolean().optional(),
  error: z.string().nullable().optional(),
  checkedAt: z.string().nullable().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
}).nullable().optional();
const upgradeStatusResponse = z.object({
  available: z.boolean().nullable().optional(),
  currentVersion: z.string().nullable().optional(),
  latestVersion: z.string().nullable().optional(),
  upgrade: z.object({ supported: z.boolean().nullable().optional() }).nullable().optional(),
  runtimeUpdate: runtimeUpdateSchema,
});
const runtimeUpdateResponse = z.object({
  runtimeUpdate: runtimeUpdateSchema,
});

export type OpenCodeUpgradeStatus = {
  /** Installed OpenCode version, or null when the server could not read it. */
  currentVersion: string | null;
  /** Newer version to announce, or null when there is nothing to announce. */
  availableVersion: string | null;
  /** True only when the server can run the upgrade itself. */
  supported: boolean;
  /** Background updater for the OpenCode runtime owned by SuperWagie. */
  runtimeUpdate: z.infer<typeof runtimeUpdateSchema>;
};

/** Throws on failure so a failed check never reads as "no update". */
export async function fetchOpenCodeUpgradeStatus(): Promise<OpenCodeUpgradeStatus> {
  const response = await runtimeFetch('/api/opencode/upgrade-status', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.statusText || 'engine upgrade status check failed');
  const parsed = upgradeStatusResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('engine upgrade status check failed');
  const status = parsed.data;
  const currentVersion = status.currentVersion?.trim() || null;
  const availableVersion = resolveOpenCodeUpgradeStatusVersion(status) || null;
  return {
    currentVersion,
    availableVersion,
    supported: isOpenCodeUpgradeSupported(status),
    runtimeUpdate: status.runtimeUpdate ?? null,
  };
}

/** Poll the managed runtime without making the server contact npm or OpenCode. */
export async function fetchOpenCodeRuntimeUpdate(): Promise<OpenCodeUpgradeStatus['runtimeUpdate']> {
  const response = await runtimeFetch('/api/opencode/runtime-update', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(response.statusText || 'engine runtime update status failed');
  const parsed = runtimeUpdateResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('engine runtime update status failed');
  return parsed.data.runtimeUpdate ?? null;
}

/**
 * Installs the latest OpenCode on the server. Resolves with the installed
 * version when the server reports one; throws with the server's reason, or
 * with `fallbackError` when it gives none.
 */
export async function runOpenCodeUpgrade(fallbackError: string): Promise<string | null> {
  const response = await runtimeFetch('/api/opencode/upgrade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  });
  const parsed = upgradeResponse.safeParse(await response.json().catch(() => null));
  const payload = parsed.success ? parsed.data : null;
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || response.statusText || fallbackError);
  }
  return payload?.version ?? null;
}
