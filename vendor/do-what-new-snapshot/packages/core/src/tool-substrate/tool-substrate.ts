import type { RuntimeSessionConfig } from "@do-what/protocol";
import { CoreError } from "../errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { ToolExecutionContext } from "./tool-execution-context.js";

export interface ToolSubstrateDependencies {
  readonly generateExecutionId: () => string;
  readonly now: () => string;
}

export interface ToolSubstrateContextOptions {
  readonly affectedPathRoots?: readonly string[];
}

export class ToolSubstrate {
  public constructor(private readonly deps: ToolSubstrateDependencies) {}

  public async withContext<T>(
    toolId: string,
    sessionConfig: Readonly<RuntimeSessionConfig>,
    fn: (ctx: Readonly<ToolExecutionContext>) => Promise<T>,
    options: ToolSubstrateContextOptions = {}
  ): Promise<T> {
    const parsedToolId = parseToolId(toolId);
    const sessionConfigSnapshot = freezeSessionConfigSnapshot(sessionConfig);
    const context = deepFreeze({
      executionId: this.deps.generateExecutionId(),
      toolId: parsedToolId,
      workspaceId: sessionConfigSnapshot.workspace_id,
      writableRoots: sessionConfigSnapshot.writable_roots,
      affectedPathRoots: options.affectedPathRoots ?? sessionConfigSnapshot.writable_roots,
      cwd: sessionConfigSnapshot.cwd,
      sessionConfig: sessionConfigSnapshot,
      startedAt: this.deps.now()
    }) satisfies ToolExecutionContext;

    return fn(context);
  }
}

function parseToolId(toolId: string): string {
  if (typeof toolId !== "string") {
    throw new CoreError("VALIDATION", "toolId is required");
  }

  const trimmedToolId = toolId.trim();

  if (trimmedToolId.length === 0) {
    throw new CoreError("VALIDATION", "toolId is required");
  }

  return trimmedToolId;
}

function freezeSessionConfigSnapshot(
  sessionConfig: Readonly<RuntimeSessionConfig>
): Readonly<RuntimeSessionConfig> {
  return deepFreeze({
    ...sessionConfig,
    writable_roots: [...sessionConfig.writable_roots] as RuntimeSessionConfig["writable_roots"],
    allowed_mcp_servers: [...sessionConfig.allowed_mcp_servers] as RuntimeSessionConfig["allowed_mcp_servers"]
  });
}
