import React from 'react';
import type { IntegrationInfo } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { findMcpIntegration, getMcpOAuthMethods } from './mcpOAuthIntegration';
import { useRuntimeInstance } from '@/hooks/useRuntimeInstance';

/**
 * The OAuth integration OpenCode registered for an MCP server, or null while
 * it is unknown or when the server has no OAuth sign-in. Nothing is read
 * while `enabled` is false.
 */
export const useMcpOAuthIntegration = (
  serverName: string,
  directory: string | null,
  enabled = true,
): IntegrationInfo | null => {
  const isCurrentRuntime = useRuntimeInstance();
  const [result, setResult] = React.useState<{
    serverName: string; directory: string | null; isCurrentRuntime: () => boolean; integration: IntegrationInfo;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult(null);
    if (!enabled) return;
    const sdk = directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient();
    /**
     * The mcp_* integration is registered by OpenCode on the server's first
     * attempt, so the list read right after an install can race it and miss.
     * Retry on a short interval until it shows up or the panel unmounts.
     * A single load here left the sign-in panel empty until it was remounted
     * from another surface.
     */
    const load = async (attempt = 0): Promise<void> => {
      if (cancelled || !isCurrentRuntime()) return;
      try {
        const { data } = await sdk.integration.list();
        if (cancelled || !isCurrentRuntime()) return;
        const found = findMcpIntegration(data, serverName) ?? null;
        if (found) {
          setResult({ serverName, directory, isCurrentRuntime, integration: found });
          return;
        }
        if (attempt < 8) {
          timer = setTimeout(() => { void load(attempt + 1); }, 750);
        }
      } catch (error) {
        if (cancelled || !isCurrentRuntime()) return;
        console.error('Failed to load MCP integrations:', error);
        if (attempt < 8) {
          timer = setTimeout(() => { void load(attempt + 1); }, 750);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [directory, enabled, serverName, isCurrentRuntime]);

  const integration = enabled && result?.serverName === serverName && result.directory === directory && result.isCurrentRuntime()
    ? result.integration : null;
  return getMcpOAuthMethods(integration ?? undefined).length > 0 ? integration : null;
};
