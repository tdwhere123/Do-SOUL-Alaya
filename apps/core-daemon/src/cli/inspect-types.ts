import type { AlayaCliArgsSchema } from "./bridge.js";

export interface InspectCommandDependencies {
  readonly generateToken?: () => string;
  readonly getRequestToken?: () => string | undefined;
  readonly spawnInspector?: (input: SpawnInspectorInput) => InspectorChildProcess;
  readonly startDaemonServer?: (options: InspectDaemonListenOptions) => Promise<InspectDaemonServer>;
  readonly probeDaemon?: (url: string, auth?: DaemonRequestAuth) => Promise<InspectDaemonProbeResult>;
  readonly checkPortAvailable?: (port: number) => Promise<boolean>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly inspectorEntryPath?: string;
  readonly listWorkspaces?: (
    daemonUrl: string,
    auth?: DaemonRequestAuth
  ) => Promise<readonly WorkspaceSummary[]>;
  readonly getWorkspaceById?: (
    daemonUrl: string,
    workspaceId: string,
    auth?: DaemonRequestAuth
  ) => Promise<WorkspaceLookupResult>;
}

export interface WorkspaceSummary {
  readonly workspace_id: string;
  readonly name: string | null;
  readonly repo_path: string | null;
  readonly workspace_state: string;
}

export type WorkspaceLookupResult =
  | { readonly status: "ok"; readonly workspace: WorkspaceSummary }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly detail?: string };

export interface InspectDaemonListenOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly allowEphemeralRequestToken?: boolean;
}

export interface InspectDaemonServer {
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

export type InspectDaemonProbeResult =
  | { readonly status: "compatible" }
  | { readonly status: "unavailable"; readonly detail?: string }
  | { readonly status: "auth_required"; readonly detail?: string }
  | { readonly status: "missing_capability"; readonly detail?: string };

export interface DaemonRequestAuth {
  readonly requestToken?: string;
}

export interface SpawnInspectorInput {
  readonly port: number;
  readonly token: string;
  readonly workspaceId: string;
  readonly inspectorEntryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface InspectorChildProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
}

export interface BrowserOpenerChildProcess {
  unref(): void;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type BrowserOpenerSpawn = (
  command: string,
  args: readonly string[]
) => BrowserOpenerChildProcess;

export interface InspectArgs {
  readonly open: boolean;
  readonly port: number;
  readonly token: string | null;
  readonly workspace: string | null;
}

export type InspectArgsSchema = AlayaCliArgsSchema<InspectArgs>;
