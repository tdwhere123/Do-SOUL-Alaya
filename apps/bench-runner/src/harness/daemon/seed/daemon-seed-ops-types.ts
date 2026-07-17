import type { AlayaDaemonRuntime } from "@do-soul/alaya";

export interface CreateBenchSeedOpsInput {
  readonly activeRuntime: AlayaDaemonRuntime;
  readonly activeContext: { workspaceId: string; runId: string };
  readonly dataDir: string;
  readonly callMcpTool: <TOutput>(
    name: string,
    args: Record<string, unknown>
  ) => Promise<TOutput>;
  readonly readMaterializedObjects: (
    signalId: string
  ) => Promise<{ readonly memoryId: string; readonly evidenceId: string | null }>;
  readonly reviewerIdentity: string;
  readonly reviewerToken: string;
}
