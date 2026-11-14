import type { Express } from "express";
import type { Server } from "http";
import type { OfficialSelection, OfficialSelectionRequest } from '@openchamber/ui/lib/guests/mobile-official';
import type { CreationApprovalOperation, CreationApprovalResult } from '@openchamber/ui/lib/guests/creation-approval';

type NativeAccountAuthentication = { kind: 'bearer'; token: string } | { kind: 'cookie'; cookie: string; host: string };

export interface WebUiServerController {
  /** Present only when enabled by an embedded native bootstrap. Never exposed over HTTP. */
  nativeOfficialSelections?: {
    select(input: { authentication: NativeAccountAuthentication; input: OfficialSelectionRequest; isCurrent: () => boolean }): Promise<OfficialSelection>;
    revoke(input: { authentication: NativeAccountAuthentication; id: string; isCurrent: () => boolean }): Promise<{ revoked: true }>;
    creationApproval(input: { authentication: NativeAccountAuthentication; input: CreationApprovalOperation; isCurrent: () => boolean }): Promise<CreationApprovalResult>;
  };
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  isReady: () => boolean;
  getManagedOpenCodePreflight: () => Promise<boolean>;
  restartOpenCode: () => Promise<void>;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export interface DesktopUpdateInfo {
  available: boolean;
  currentVersion?: string;
  version?: string | null;
  body?: string | null;
  date?: string | null;
}

export interface DesktopUpdater {
  check: () => Promise<DesktopUpdateInfo>;
  install: () => Promise<DesktopUpdateInfo>;
  restart: () => Promise<void> | void;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  desktopUpdater?: DesktopUpdater;
  nativeOfficialSelections?: boolean;
  onDesktopNotificationWithdraw?: (input: { tag: string }) => { status: 'withdrawn' | 'unsupported' | 'unknown'; count?: number };
  /** App-owned built-in resources outside Electron's ASAR archive. */
  builtInExtensionsDir?: string;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
};
