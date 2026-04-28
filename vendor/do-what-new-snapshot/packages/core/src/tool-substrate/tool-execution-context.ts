import type { RuntimeSessionConfig } from "@do-what/protocol";

export interface ToolExecutionContext {
  readonly executionId: string;
  readonly toolId: string;
  readonly workspaceId: string;
  readonly writableRoots: readonly string[];
  readonly affectedPathRoots: readonly string[];
  readonly cwd: string;
  readonly sessionConfig: Readonly<RuntimeSessionConfig>;
  readonly startedAt: string;
}
