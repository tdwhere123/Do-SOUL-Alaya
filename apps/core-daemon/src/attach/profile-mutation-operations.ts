import {
  ALAYA_LEGACY_SLASH_COMMAND,
  ALAYA_OPERATOR_INSTRUCTIONS,
  ALAYA_SLASH_ALIAS
} from "./profile-mutation-constants.js";
import { resolveAlayaMcpLauncher, resolveAlayaSlashCommand } from "./profile-mutation-launcher.js";
import type {
  ProfileMutationConflict,
  ProfileMutationFs,
  ProfileMutationOperation,
  ProfileTarget
} from "./profile-mutation-types.js";
import { ProfileMutationError } from "./profile-mutation-types.js";
import {
  appendTomlBlock,
  extractCodexSlashCommand,
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
      env: { ALAYA_AGENT_TARGET: "claude-code" },
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

export function upsertSlashAlias(
  target: ProfileTarget,
  before: string | undefined,
  env: NodeJS.ProcessEnv
): { readonly content: string; readonly conflict?: ProfileMutationConflict } {
  const slashCommand = resolveAlayaSlashCommand(env);
  if (target === "codex") {
    const existingCommand = extractCodexSlashCommand(before ?? "");
    return {
      content: appendTomlBlock(
        removeTomlBlock(before ?? "", "[slash_commands.alaya-inspect]"),
        renderCodexSlashBlock(slashCommand)
      ),
      conflict: buildAttachConflict(existingCommand, slashCommand)
    };
  }

  const parsed = parseJsonObject(before, "Claude slash command registry");
  const currentCommands = isRecord(parsed.commands) ? parsed.commands : {};
  const existingEntry = currentCommands[ALAYA_SLASH_ALIAS];
  const existingCommand =
    isRecord(existingEntry) && typeof existingEntry.command === "string" ? existingEntry.command : undefined;
  parsed.commands = {
    ...currentCommands,
    [ALAYA_SLASH_ALIAS]: {
      command: slashCommand,
      description: "Open the Alaya Memory Inspector."
    }
  };

  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    conflict: buildAttachConflict(existingCommand, slashCommand)
  };
}

export function removeSlashAlias(
  target: ProfileTarget,
  before: string | undefined,
  env: NodeJS.ProcessEnv
): { readonly content: string | undefined; readonly changed: boolean; readonly conflict?: ProfileMutationConflict } {
  const slashCommand = resolveAlayaSlashCommand(env);
  if (before === undefined || before.trim().length === 0) {
    return { content: before, changed: false };
  }

  if (target === "codex") {
    const existingCommand = extractCodexSlashCommand(before);
    const after = removeTomlBlock(before, "[slash_commands.alaya-inspect]");
    return {
      content: after,
      changed: normalizeFileText(after) !== normalizeFileText(before),
      conflict: buildDetachConflict(existingCommand, slashCommand)
    };
  }

  const parsed = parseJsonObject(before, "Claude slash command registry");
  if (!isRecord(parsed.commands) || !(ALAYA_SLASH_ALIAS in parsed.commands)) {
    return { content: before, changed: false };
  }

  const existingEntry = parsed.commands[ALAYA_SLASH_ALIAS];
  const existingCommand =
    isRecord(existingEntry) && typeof existingEntry.command === "string" ? existingEntry.command : undefined;
  const nextCommands = { ...parsed.commands };
  delete nextCommands[ALAYA_SLASH_ALIAS];
  parsed.commands = nextCommands;
  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    changed: true,
    conflict: buildDetachConflict(existingCommand, slashCommand)
  };
}

export async function detectActivePath(fs: ProfileMutationFs, candidates: readonly string[]): Promise<string> {
  if (candidates.length === 0) {
    throw new ProfileMutationError("No profile path candidates resolved.", 66);
  }
  for (const candidate of candidates) {
    if ((await fs.readText(candidate)) !== undefined) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export function uniqueNonEmptyPaths(paths: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const candidate of paths) {
    if (candidate === undefined) {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    values.push(trimmed);
  }
  return values;
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

function buildAttachConflict(
  existingCommand: string | undefined,
  currentCommand: string
): ProfileMutationConflict | undefined {
  if (existingCommand === undefined || isManagedSlashCommand(existingCommand, currentCommand)) {
    return undefined;
  }
  return {
    message: `${ALAYA_SLASH_ALIAS} is currently bound to "${existingCommand}"; confirming will overwrite it.`,
    existingCommand
  };
}

function buildDetachConflict(
  existingCommand: string | undefined,
  currentCommand: string
): ProfileMutationConflict | undefined {
  if (existingCommand === undefined || isManagedSlashCommand(existingCommand, currentCommand)) {
    return undefined;
  }
  return {
    message: `${ALAYA_SLASH_ALIAS} is currently bound to "${existingCommand}"; confirming will remove this custom binding.`,
    existingCommand
  };
}

function isManagedSlashCommand(existingCommand: string, currentCommand: string): boolean {
  if (existingCommand === ALAYA_LEGACY_SLASH_COMMAND) {
    return true;
  }
  if (existingCommand === currentCommand) {
    return true;
  }
  return normalizeSlashCommandForCompare(existingCommand) === normalizeSlashCommandForCompare(currentCommand);
}

function normalizeSlashCommandForCompare(command: string): string {
  return command.replace(/\\/g, "/").trim().toLowerCase();
}

function renderCodexMcpBlock(env: NodeJS.ProcessEnv): string {
  const launcher = resolveAlayaMcpLauncher(env);
  return [
    "[mcp_servers.alaya]",
    `command = ${JSON.stringify(launcher.command)}`,
    `args = ${JSON.stringify([...launcher.args])}`,
    `env = { ALAYA_AGENT_TARGET = "codex" }`,
    `operator_instructions = ${JSON.stringify(ALAYA_OPERATOR_INSTRUCTIONS)}`
  ].join("\n");
}

function renderCodexSlashBlock(slashCommand: string): string {
  return [
    "[slash_commands.alaya-inspect]",
    `command = ${JSON.stringify(slashCommand)}`,
    `description = ${JSON.stringify("Open the Alaya Memory Inspector.")}`
  ].join("\n");
}
