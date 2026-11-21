import { ALAYA_OPERATOR_INSTRUCTIONS } from "./profile-mutation-constants.js";
import { buildAttachedAgentMcpChildEnv } from "../attached-agent-mcp-child-env.js";
import { resolveAlayaMcpLauncher } from "./profile-mutation-launcher.js";
import type {
  ProfileMutationFs,
  ProfileMutationOperation,
  ProfileTarget
} from "./profile-mutation-types.js";
import { ProfileMutationError } from "./profile-mutation-types.js";
import {
  appendTomlBlock,
  isRecord,
  normalizeFileText,
  parseJsonObject,
  removeTomlBlock
} from "./profile-mutation-text.js";

export async function restoreOperationBefore(
  fs: ProfileMutationFs,
  operation: ProfileMutationOperation
): Promise<void> {
  if (operation.before === undefined) {
    await fs.removeText(operation.path);
    return;
  }
  await fs.writeTextAtomic(operation.path, operation.before, 0o600);
}

export function upsertMcpEntry(target: ProfileTarget, before: string | undefined, env: NodeJS.ProcessEnv): string {
  if (target === "codex") {
    const withoutExisting = removeTomlBlock(before ?? "", "[mcp_servers.alaya]");
    return appendTomlBlock(withoutExisting, renderCodexMcpBlock(env));
  }

  const parsed = parseJsonObject(before, ".claude.json");
  const currentMcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const launcher = resolveAlayaMcpLauncher(env);
  parsed.mcpServers = {
    ...currentMcpServers,
    alaya: {
      command: launcher.command,
      args: [...launcher.args],
      env: buildAttachedAgentMcpChildEnv("claude-code"),
      operatorInstructions: ALAYA_OPERATOR_INSTRUCTIONS
    }
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function removeMcpEntry(
  target: ProfileTarget,
  before: string | undefined
): { readonly content: string | undefined; readonly changed: boolean } {
  if (before === undefined || before.trim().length === 0) {
    return { content: before, changed: false };
  }

  if (target === "codex") {
    const after = removeTomlBlock(before, "[mcp_servers.alaya]");
    return {
      content: after,
      changed: normalizeFileText(after) !== normalizeFileText(before)
    };
  }

  const parsed = parseJsonObject(before, ".claude.json");
  if (!isRecord(parsed.mcpServers) || !("alaya" in parsed.mcpServers)) {
    return { content: before, changed: false };
  }

  const nextMcpServers = { ...parsed.mcpServers };
  delete nextMcpServers.alaya;
  parsed.mcpServers = nextMcpServers;
  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    changed: true
  };
}

export function requireHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (home === undefined || home.trim().length === 0) {
    throw new ProfileMutationError("HOME is required to resolve profile paths.", 66);
  }
  return home;
}

export function readSingleLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lineBreakIndex = buffer.indexOf("\n");
      if (lineBreakIndex >= 0) {
        const line = buffer.slice(0, lineBreakIndex);
        cleanup();
        resolve(line.replace(/\r$/u, ""));
      }
    };

    const onEnd = () => {
      cleanup();
      resolve(buffer.trim());
    };

    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onEnd);
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onEnd);
  });
}

function renderCodexMcpBlock(env: NodeJS.ProcessEnv): string {
  const launcher = resolveAlayaMcpLauncher(env);
  const childEnv = buildAttachedAgentMcpChildEnv("codex");
  const envEntries = Object.entries(childEnv)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join(", ");
  return [
    "[mcp_servers.alaya]",
    `command = ${JSON.stringify(launcher.command)}`,
    `args = ${JSON.stringify([...launcher.args])}`,
    `env = { ${envEntries} }`,
    `operator_instructions = ${JSON.stringify(ALAYA_OPERATOR_INSTRUCTIONS)}`
  ].join("\n");
}
