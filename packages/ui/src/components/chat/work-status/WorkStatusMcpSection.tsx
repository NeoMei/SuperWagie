import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useMcpStore } from '@/stores/useMcpStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { opencodeClient } from '@/lib/opencode/client';
import { isIntegrationDenied } from '@/lib/opencode/projection';
import { useConfigStore } from '@/stores/useConfigStore';
import { McpIcon } from '@/components/icons/McpIcon';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { toast } from 'sonner';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusRowAction } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { WorkStatusTouchContext } from './touchContext';
import { useMcpDirectory } from '@/components/mcp/useMcpDirectory';
import { McpOAuthSignIn } from '@/components/sections/mcp/McpOAuthSignIn';
import { useRuntimeInstance } from '@/hooks/useRuntimeInstance';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const MCP_STATUS_MAX_AGE_MS = 60_000;

/**
 * MCP servers with their on/off switches, reusing the dropdown's own action.
 */
export const WorkStatusMcpSection: React.FC<Props> = ({ sessionId, directory: selectedDirectory }) => {
  const touch = React.useContext(WorkStatusTouchContext);
  const { t } = useI18n();
  const directory = useMcpDirectory(true, { sessionId, directory: selectedDirectory });

  const mcpStatus = useMcpStore(
    React.useCallback((state) => directory ? state.getStatusForDirectory(directory) : null, [directory]),
  );
  const ensureMcpFresh = useMcpStore((state) => state.ensureFresh);
  const setEnabled = useMcpStore((state) => state.setEnabled);
  const isConnected = useConfigStore((state) => state.isConnected);
  const [busyServer, setBusyServer] = React.useState<string | null>(null);
  const isCurrentRuntime = useRuntimeInstance();
  const signInScope = React.useMemo(() => ({ directory, sessionId, isCurrentRuntime }), [directory, sessionId, isCurrentRuntime]);
  const scopeRef = React.useRef(signInScope);
  scopeRef.current = signInScope;
  useMcpConfigStore((state) => state.serversByDirectory);
  const busyOperation = React.useRef<symbol | null>(null);
  const authIntent = React.useRef<{ server: string; directory: string } | null>(null);
  const [signIn, setSignIn] = React.useState<{ server: string; directory: string; sessionId: string | null; owner: () => boolean } | null>(null);
  const liveSignIn = signIn?.directory === directory && signIn.sessionId === sessionId && signIn.owner() && mcpStatus?.[signIn.server]?.status.status === 'needs_auth' && useMcpConfigStore.getState().getMcpByName(signIn.server, directory)?.disabled !== true ? signIn : null;
  const signInRef = React.useRef(liveSignIn);
  signInRef.current = liveSignIn;
  React.useEffect(() => {
    busyOperation.current = null;
    authIntent.current = null;
    setBusyServer(null);
    setSignIn(null);
  }, [directory, sessionId, isCurrentRuntime]);
  React.useEffect(() => useMcpConfigStore.subscribe(() => {
    const intent = authIntent.current;
    if (!intent) return;
    const config = useMcpConfigStore.getState().getMcpByName(intent.server, intent.directory);
    if (!config || config.type !== 'remote' || config.disabled || config.oauth === false) {
      authIntent.current = null;
      setSignIn(null);
    }
  }), []);

  // The panel must not depend on the header dropdown having been mounted or
  // opened to know its MCP servers. Silent and background-gated, so it cannot
  // compete with chat bootstrap traffic for sockets. The section remounts on
  // every session switch, so it only asks for a status that is missing or
  // older than a minute; connect/disconnect/auth refresh on their own.
  // `isConnected` is a dependency, not a gate: MCP status is cached by
  // directory alone and dropped on an instance switch, and two instances can
  // hold the same project path — so the switch itself has to trigger the ask.
  React.useEffect(() => {
    if (!directory) return;
    void runBackgroundNetworkTask(() => ensureMcpFresh({ directory, silent: true, maxAgeMs: MCP_STATUS_MAX_AGE_MS }));
  }, [directory, ensureMcpFresh, isConnected]);

  const mcpServers = React.useMemo(
    () => Object.entries(mcpStatus ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [mcpStatus],
  );
  const mcpConnected = React.useMemo(
    () => mcpServers.filter(([, entry]) => entry?.status.status === 'connected').length,
    [mcpServers],
  );

  const startSignIn = React.useCallback(async (name: string) => {
    if (!directory || !isCurrentRuntime() || scopeRef.current !== signInScope) return;
    if (signInRef.current?.server === name) return;
    const scope = signInScope;
    const operation = Symbol();
    busyOperation.current = operation;
    const current = () => scopeRef.current === scope && isCurrentRuntime() && busyOperation.current === operation;
    setBusyServer(name);
    try {
      if (!await useMcpConfigStore.getState().loadMcpConfigs({ directory })) return;
      const config = useMcpConfigStore.getState().getMcpByName(name, directory);
      if (!current() || !config || config.type !== 'remote' || config.disabled || config.oauth === false) return;
      const intent = { server: name, directory };
      authIntent.current = intent;
      const policies = await opencodeClient.getIntegrationPolicies(directory);
      if (!current() || authIntent.current !== intent || isIntegrationDenied(policies, `mcp:${name}`)) return;
      setSignIn((previous) => previous?.server === name && previous.directory === directory && previous.sessionId === sessionId && previous.owner()
        ? previous : { server: name, directory, sessionId, owner: () => isCurrentRuntime() && authIntent.current === intent });
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('mcpDropdown.status.unknownError'));
    } finally {
      if (current()) setBusyServer(null);
    }
  }, [directory, isCurrentRuntime, sessionId, signInScope, t]);

  const handleToggle = React.useCallback(async (name: string, next: boolean) => {
    if (!directory || scopeRef.current !== signInScope || !isCurrentRuntime()) return;
    // Switching on a server that is waiting for sign-in cannot connect: it only
    // repeats the attempt that produced `needs_auth`. Authorization is the real
    // action, and the dropdown already routes the same switch that way — the
    // two surfaces must not disagree about what this control does.
    const status = (mcpStatus ?? {})[name]?.status.status;
    if (next && status === 'needs_auth') {
      void startSignIn(name);
      return;
    }

    const operation = Symbol();
    busyOperation.current = operation;
    const current = () => scopeRef.current === signInScope && isCurrentRuntime() && busyOperation.current === operation;
    setBusyServer(name);
    try {
      await setEnabled(name, next, directory);
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('mcpDropdown.status.unknownError'));
    } finally {
      if (current()) setBusyServer(null);
    }
  }, [directory, isCurrentRuntime, mcpStatus, signInScope, startSignIn, setEnabled, t]);

  useReportWorkStatusPresence('mcp', mcpServers.length > 0);

  if (mcpServers.length === 0) return null;

  return (
    <WorkStatusCollapsibleSection
      id="mcp"
      title={t('chat.workStatus.section.mcp')}
      iconNode={<McpIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      summary={`${mcpConnected}/${mcpServers.length}`}
    >
      {mcpServers.map(([name, entry]) => {
        const connected = entry?.status.status === 'connected';
        const busy = busyServer === name;
        const needsAuth = entry?.status.status === 'needs_auth';
        const failed = entry?.status.status === 'failed';
        const toggle = (
          <Switch
            checked={connected}
            disabled={busy}
            loading={busy}
            className={cn('disabled:opacity-100 data-[checked]:bg-status-info', !touch && 'scale-75')}
            aria-label={t('chat.workStatus.mcp.toggle', { name })}
            onCheckedChange={(checked) => { void handleToggle(name, checked); }}
          />
        );
        // A server asking for sign-in or reporting a failure is asking to be
        // acted on; the state is the affordance, so it is the button.
        const stateAction = needsAuth ? (
          <WorkStatusRowAction
            tone="warning"
            disabled={busy}
            onClick={() => { void startSignIn(name); }}
          >
            {t('chat.workStatus.mcp.needsAuth')}
          </WorkStatusRowAction>
        ) : failed ? (
          <WorkStatusRowAction
            tone="error"
            disabled={busy}
            onClick={() => { void handleToggle(name, true); }}
          >
            {t('chat.workStatus.mcp.failed')}
          </WorkStatusRowAction>
        ) : null;
        return (
          <React.Fragment key={name}>
          <WorkStatusRow
            // On the phone a switch goes on the row's end, full size, as
            // settings rows put it; the icon column is too narrow for one.
            leading={touch ? undefined : toggle}
            label={name}
            muted={!connected}
            value={touch ? <>{stateAction}{toggle}</> : stateAction ?? undefined}
          />
          {liveSignIn?.server === name ? (
            <McpOAuthSignIn
              serverName={name}
              directory={liveSignIn.directory}
              autoStart
              showStartButton={false}
              onConnected={async () => {
                if (signInRef.current !== liveSignIn || !liveSignIn.owner() || useMcpConfigStore.getState().getMcpByName(name, liveSignIn.directory)?.disabled === true) return;
                await setEnabled(name, true, liveSignIn.directory);
                if (signInRef.current === liveSignIn && liveSignIn.owner()) setSignIn(null);
              }}
            />
          ) : null}
          </React.Fragment>
        );
      })}
    </WorkStatusCollapsibleSection>
  );
};
