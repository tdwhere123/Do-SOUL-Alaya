import type { AlayaCliResult } from "../bridge.js";
import {
  executeAttachCommand,
  type AttachCommandContext,
  type AttachCommandDeps,
  type TrustStateRecorderPort
} from "./execute-attach-command.js";

export type { TrustStateRecorderPort };

export type AttachCodexCommandContext = AttachCommandContext;
export type AttachCodexCommandDeps = AttachCommandDeps;

export interface AttachCodexCommandSpec {
  readonly target: "codex";
  readonly description: string;
  execute(ctx: AttachCodexCommandContext): Promise<AlayaCliResult>;
}

export function createAttachCodexCommandSpec(deps: AttachCodexCommandDeps = {}): AttachCodexCommandSpec {
  return {
    target: "codex",
    description: "Attach Alaya MCP + /alaya-inspect to Codex profile files.",
    execute: async (ctx) => await executeAttachCodex(ctx, deps)
  };
}

async function executeAttachCodex(
  ctx: AttachCodexCommandContext,
  deps: AttachCodexCommandDeps
): Promise<AlayaCliResult> {
  return await executeAttachCommand("codex", "attached codex profile", ctx, deps);
}
