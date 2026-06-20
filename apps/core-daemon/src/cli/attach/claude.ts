import type { AlayaCliResult } from "../bridge.js";
import {
  executeAttachCommand,
  type AttachCommandContext,
  type AttachCommandDeps,
  type TrustStateRecorderPort
} from "./execute-attach-command.js";

export type { TrustStateRecorderPort };

export type AttachClaudeCommandContext = AttachCommandContext;
export type AttachClaudeCommandDeps = AttachCommandDeps;

export interface AttachClaudeCommandSpec {
  readonly target: "claude-code";
  readonly description: string;
  execute(ctx: AttachClaudeCommandContext): Promise<AlayaCliResult>;
}

export function createAttachClaudeCommandSpec(deps: AttachClaudeCommandDeps = {}): AttachClaudeCommandSpec {
  return {
    target: "claude-code",
    description: "Attach Alaya MCP + /alaya-inspect to Claude Code profile files.",
    execute: async (ctx) => await executeAttachClaude(ctx, deps)
  };
}

async function executeAttachClaude(
  ctx: AttachClaudeCommandContext,
  deps: AttachClaudeCommandDeps
): Promise<AlayaCliResult> {
  return await executeAttachCommand("claude-code", "attached claude-code profile", ctx, deps);
}
