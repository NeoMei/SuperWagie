import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { isIntegrationDenied, type IntegrationPolicy } from '@/lib/opencode/projection';
import { useRuntimeInstance } from '@/hooks/useRuntimeInstance';

const NO_POLICIES: IntegrationPolicy[] = [];

/**
 * Whether OpenCode's config blocks an MCP server (`mcp:<name>`) or a skill
 * (`skill:<id>`) in a directory through an `integration.use` policy. OpenCode
 * drops a blocked entry from its own lists, while these pages list what the
 * config files hold, so the row would otherwise sit there and never load.
 * Nothing reads as blocked until the config has been read; a failed read
 * leaves every row unmarked.
 */
export const useIntegrationPolicyBlock = (directory: string | null): ((resource: string) => boolean) => {
  const isCurrentRuntime = useRuntimeInstance();
  const [result, setResult] = React.useState<{
    directory: string | null; isCurrentRuntime: () => boolean; policies: IntegrationPolicy[];
  } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setResult(null);
    opencodeClient.getIntegrationPolicies(directory)
      .then((policies) => {
        if (!cancelled && isCurrentRuntime()) setResult({ directory, isCurrentRuntime, policies });
      })
      .catch((error) => {
        if (cancelled || !isCurrentRuntime()) return;
        console.warn('[settings] could not read OpenCode integration policies:', error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [directory, isCurrentRuntime]);
  const policies = result?.directory === directory && result.isCurrentRuntime() ? result.policies : NO_POLICIES;
  return React.useCallback((resource: string) => isIntegrationDenied(policies, resource), [policies]);
};
