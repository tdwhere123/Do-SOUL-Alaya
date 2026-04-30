import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { soulToolDefs } from "@do-soul/alaya-engine-gateway";

export type ProfileTarget = "codex" | "claude-code";
export type ProfileMutationDirection = "add" | "remove";

export interface ProfilePaths {
  readonly mcpConfigPath: string;
  readonly slashCommandsPath: string;
  readonly slashPathCandidates: readonly string[];
}

export interface ProfileMutationConflict {
  readonly message: string;
  readonly existingCommand: string;
}

export interface ProfileMutationOperation {
  readonly recordKind: "mcp_server_entry" | "slash_alias";
  readonly label: string;
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly changed: boolean;
  readonly alreadyAbsent: boolean;
  readonly conflict?: ProfileMutationConflict;
}

export interface ProfileMutationPlan {
  readonly target: ProfileTarget;
  readonly direction: ProfileMutationDirection;
  readonly paths: ProfilePaths;
  readonly operations: readonly ProfileMutationOperation[];
  readonly auditEventKind: "profile_mutation_attach" | "profile_mutation_detach";
}

export interface ProfileMutationAuditRecord {
  readonly record_kind: ProfileMutationOperation["recordKind"];
  readonly path: string;
}

export interface ProfileMutationAuditRow {
  readonly event_kind: "profile_mutation_attach" | "profile_mutation_detach";
  readonly target: ProfileTarget;
  readonly direction: ProfileMutationDirection;
  readonly changed_paths: readonly string[];
  readonly records: readonly ProfileMutationAuditRecord[];
  readonly created_at: string;
}

export interface ProfileMutationAuditWriter {
  append(row: ProfileMutationAuditRow): Promise<void>;
  rollback?(row: ProfileMutationAuditRow): Promise<void>;
}

export interface ProfileMutationFs {
  readText(filePath: string): Promise<string | undefined>;
  writeTextAtomic(filePath: string, content: string, mode?: number): Promise<void>;
  removeText(filePath: string): Promise<void>;
}

export interface ResolveProfilePathsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fs?: ProfileMutationFs;
}

export interface ProfileMutationBuildOptions extends ResolveProfilePathsOptions {}

export interface ProfileMutationApplyOptions {
  readonly fs?: ProfileMutationFs;
  readonly auditWriter?: ProfileMutationAuditWriter;
  readonly allowConflicts?: boolean;
  readonly nowIso?: () => string;
}

export interface ProfileMutationConfirmIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
}

export interface ProfileMutationApplyResult {
  readonly changed: boolean;
  readonly auditRow: ProfileMutationAuditRow | undefined;
}

export class ProfileMutationError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: number
  ) {
    super(message);
    this.name = "ProfileMutationError";
  }
}

export const SUPPORTED_PROFILE_TARGETS = Object.freeze(["codex", "claude-code"] as const);
export const ALAYA_SLASH_ALIAS = "/alaya-inspect";
export const ALAYA_SLASH_COMMAND = "alaya inspect --open";
export const ALAYA_MCP_COMMAND = "alaya";
export const ALAYA_MCP_ARGS = Object.freeze(["mcp", "stdio"] as const);
export const PROFILE_MUTATION_CONFIRM_PROMPT = "Apply profile mutation changes? [y/N] ";
export const PUBLIC_SOUL_TOOL_NAMES = Object.freeze(soulToolDefs.map((toolDef) => toolDef.name));

export const ALAYA_OPERATOR_INSTRUCTIONS = [
  `Use only these public SOUL memory tools: ${PUBLIC_SOUL_TOOL_NAMES.join(", ")}.`,
  "Call soul.recall before memory-sensitive work.",
  "Use soul.open_pointer before citing recalled evidence.",
  "Create new memory only through soul.emit_candidate_signal or soul.propose_memory_update.",
  "Report delivery usage with soul.report_context_usage."
].join(" ");

export async function buildAttachProfileMutationPlan(
  target: ProfileTarget,
  options: ProfileMutationBuildOptions = {}
): Promise<ProfileMutationPlan> {
  const fs = options.fs ?? createNodeProfileMutationFs();
  const paths = await resolveProfilePaths(target, { env: options.env, fs });
  const mcpBefore = await fs.readText(paths.mcpConfigPath);
  const slashBefore = await fs.readText(paths.slashCommandsPath);
  const mcpAfter = upsertMcpEntry(target, mcpBefore);
  const slashResult = upsertSlashAlias(target, slashBefore);

  return {
    target,
    direction: "add",
    paths,
    auditEventKind: "profile_mutation_attach",
    operations: [
      {
        recordKind: "mcp_server_entry",
        label: `${target} MCP server entry`,
        path: paths.mcpConfigPath,
        before: mcpBefore,
        after: mcpAfter,
        changed: normalizeFileText(mcpBefore) !== normalizeFileText(mcpAfter),
        alreadyAbsent: false
      },
      {
        recordKind: "slash_alias",
        label: `${target} ${ALAYA_SLASH_ALIAS} slash alias`,
        path: paths.slashCommandsPath,
        before: slashBefore,
        after: slashResult.content,
        changed: normalizeFileText(slashBefore) !== normalizeFileText(slashResult.content),
        alreadyAbsent: false,
        conflict: slashResult.conflict
      }
    ]
  };
}

export async function buildDetachProfileMutationPlan(
  target: ProfileTarget,
  options: ProfileMutationBuildOptions = {}
): Promise<ProfileMutationPlan> {
  const fs = options.fs ?? createNodeProfileMutationFs();
  const paths = await resolveProfilePaths(target, { env: options.env, fs });
  const mcpBefore = await fs.readText(paths.mcpConfigPath);
  const slashBefore = await fs.readText(paths.slashCommandsPath);
  const mcpRemoval = removeMcpEntry(target, mcpBefore);
  const slashRemoval = removeSlashAlias(target, slashBefore);

  return {
    target,
    direction: "remove",
    paths,
    auditEventKind: "profile_mutation_detach",
    operations: [
      {
        recordKind: "mcp_server_entry",
        label: `${target} MCP server entry`,
        path: paths.mcpConfigPath,
        before: mcpBefore,
        after: mcpRemoval.content,
        changed: mcpRemoval.changed,
        alreadyAbsent: !mcpRemoval.changed
      },
      {
        recordKind: "slash_alias",
        label: `${target} ${ALAYA_SLASH_ALIAS} slash alias`,
        path: paths.slashCommandsPath,
        before: slashBefore,
        after: slashRemoval.content,
        changed: slashRemoval.changed,
        alreadyAbsent: !slashRemoval.changed,
        conflict: slashRemoval.conflict
      }
    ]
  };
}

export async function resolveProfilePaths(
  target: ProfileTarget,
  options: ResolveProfilePathsOptions = {}
): Promise<ProfilePaths> {
  const env = options.env ?? process.env;
  const fs = options.fs ?? createNodeProfileMutationFs();
  const home = requireHome(env);

  if (target === "codex") {
    const codexHome = env.CODEX_HOME ?? join(home, ".codex");
    const mcpConfigPath = env.ALAYA_CODEX_CONFIG_PATH ?? join(codexHome, "config.toml");
    const slashPathCandidates = uniqueNonEmptyPaths([
      env.ALAYA_CODEX_SLASH_COMMANDS_PATH,
      join(codexHome, "slash-commands.toml"),
      join(codexHome, "commands", "slash-commands.toml")
    ]);
    return {
      mcpConfigPath,
      slashCommandsPath: await detectActivePath(fs, slashPathCandidates),
      slashPathCandidates
    };
  }

  const mcpConfigPath = env.ALAYA_CLAUDE_CONFIG_PATH ?? env.CLAUDE_CONFIG_PATH ?? join(home, ".claude.json");
  const slashPathCandidates = uniqueNonEmptyPaths([
    env.ALAYA_CLAUDE_SLASH_COMMANDS_PATH,
    env.CLAUDE_SLASH_COMMANDS_PATH,
    join(home, ".claude", "slash-commands.json"),
    join(home, ".claude", "commands", "slash-commands.json"),
    join(home, ".claude", "commands.json")
  ]);
  return {
    mcpConfigPath,
    slashCommandsPath: await detectActivePath(fs, slashPathCandidates),
    slashPathCandidates
  };
}

export function renderProfileMutationPreview(plan: ProfileMutationPlan): string {
  const lines = [`Profile mutation preview: ${plan.direction} ${plan.target}`, ""];

  for (const operation of plan.operations) {
    lines.push(`--- ${operation.label}`);
    lines.push(`path: ${operation.path}`);

    if (operation.conflict !== undefined) {
      lines.push(`conflict: ${operation.conflict.message}`);
    }

    if (!operation.changed) {
      lines.push(operation.alreadyAbsent ? "already absent" : "no change");
      lines.push("");
      continue;
    }

    lines.push("before:");
    lines.push(indentBlock(operation.before ?? "(missing)"));
    lines.push("after:");
    lines.push(indentBlock(operation.after ?? "(removed)"));
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function renderProfileMutationConfirmPrompt(): string {
  return PROFILE_MUTATION_CONFIRM_PROMPT;
}

export async function confirmProfileMutation(io: ProfileMutationConfirmIo): Promise<boolean> {
  io.stdout.write(renderProfileMutationConfirmPrompt());
  const answer = await readSingleLine(io.stdin);
  return /^y(?:es)?$/iu.test(answer.trim());
}

export async function applyProfileMutationPlan(
  plan: ProfileMutationPlan,
  options: ProfileMutationApplyOptions = {}
): Promise<ProfileMutationApplyResult> {
  const fs = options.fs ?? createNodeProfileMutationFs();
  const allowConflicts = options.allowConflicts ?? false;
  const conflicts = plan.operations.filter((operation) => operation.conflict !== undefined);
  if (!allowConflicts && conflicts.length > 0) {
    throw new ProfileMutationError(conflicts.map((operation) => operation.conflict!.message).join("; "), 77);
  }

  const changedOperations = plan.operations.filter((operation) => operation.changed);
  if (changedOperations.length === 0) {
    return { changed: false, auditRow: undefined };
  }

  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const auditRow: ProfileMutationAuditRow = {
    event_kind: plan.auditEventKind,
    target: plan.target,
    direction: plan.direction,
    changed_paths: changedOperations.map((operation) => operation.path),
    records: changedOperations.map((operation) => ({
      record_kind: operation.recordKind,
      path: operation.path
    })),
    created_at: nowIso()
  };

  const applied: ProfileMutationOperation[] = [];
  const auditWriter = options.auditWriter;
  const auditBeforeWrite = auditWriter !== undefined && typeof auditWriter.rollback === "function";
  let auditWritten = false;

  if (auditBeforeWrite) {
    await auditWriter.append(auditRow);
    auditWritten = true;
  }

  try {
    for (const operation of changedOperations) {
      if (operation.after === undefined) {
        await fs.removeText(operation.path);
      } else {
        await fs.writeTextAtomic(operation.path, operation.after, 0o600);
      }
      applied.push(operation);
    }

    if (!auditWritten && auditWriter !== undefined) {
      await auditWriter.append(auditRow);
      auditWritten = true;
    }
  } catch (error) {
    for (const operation of applied.reverse()) {
      await restoreOperationBefore(fs, operation);
    }
    if (auditWritten && auditWriter !== undefined && typeof auditWriter.rollback === "function") {
      await auditWriter.rollback(auditRow);
    }
    throw error;
  }

  return { changed: true, auditRow };
}

export function parseProfileTarget(value: string): ProfileTarget | undefined {
  return SUPPORTED_PROFILE_TARGETS.find((target) => target === value);
}

export function createNodeProfileMutationFs(): ProfileMutationFs {
  return {
    async readText(filePath) {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async writeTextAtomic(filePath, content, mode = 0o600) {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, content, { mode });
      await rename(tempPath, filePath);
    },
    async removeText(filePath) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  };
}

async function restoreOperationBefore(fs: ProfileMutationFs, operation: ProfileMutationOperation): Promise<void> {
  if (operation.before === undefined) {
    await fs.removeText(operation.path);
    return;
  }
  await fs.writeTextAtomic(operation.path, operation.before, 0o600);
}

function upsertMcpEntry(target: ProfileTarget, before: string | undefined): string {
  if (target === "codex") {
    const withoutExisting = removeTomlBlock(before ?? "", "[mcp_servers.alaya]");
    return appendTomlBlock(withoutExisting, renderCodexMcpBlock());
  }

  const parsed = parseJsonObject(before, ".claude.json");
  const currentMcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  parsed.mcpServers = {
    ...currentMcpServers,
    alaya: {
      command: ALAYA_MCP_COMMAND,
      args: [...ALAYA_MCP_ARGS],
      operatorInstructions: ALAYA_OPERATOR_INSTRUCTIONS
    }
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function removeMcpEntry(
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

function upsertSlashAlias(
  target: ProfileTarget,
  before: string | undefined
): { readonly content: string; readonly conflict?: ProfileMutationConflict } {
  if (target === "codex") {
    const existingCommand = extractCodexSlashCommand(before ?? "");
    return {
      content: appendTomlBlock(
        removeTomlBlock(before ?? "", "[slash_commands.alaya-inspect]"),
        renderCodexSlashBlock()
      ),
      conflict: buildAttachConflict(existingCommand)
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
      command: ALAYA_SLASH_COMMAND,
      description: "Open the Alaya Memory Inspector."
    }
  };

  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    conflict: buildAttachConflict(existingCommand)
  };
}

function removeSlashAlias(
  target: ProfileTarget,
  before: string | undefined
): { readonly content: string | undefined; readonly changed: boolean; readonly conflict?: ProfileMutationConflict } {
  if (before === undefined || before.trim().length === 0) {
    return { content: before, changed: false };
  }

  if (target === "codex") {
    const existingCommand = extractCodexSlashCommand(before);
    const after = removeTomlBlock(before, "[slash_commands.alaya-inspect]");
    return {
      content: after,
      changed: normalizeFileText(after) !== normalizeFileText(before),
      conflict: buildDetachConflict(existingCommand)
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
    conflict: buildDetachConflict(existingCommand)
  };
}

function buildAttachConflict(existingCommand: string | undefined): ProfileMutationConflict | undefined {
  if (existingCommand === undefined || existingCommand === ALAYA_SLASH_COMMAND) {
    return undefined;
  }
  return {
    message: `${ALAYA_SLASH_ALIAS} is currently bound to "${existingCommand}"; confirming will overwrite it.`,
    existingCommand
  };
}

function buildDetachConflict(existingCommand: string | undefined): ProfileMutationConflict | undefined {
  if (existingCommand === undefined || existingCommand === ALAYA_SLASH_COMMAND) {
    return undefined;
  }
  return {
    message: `${ALAYA_SLASH_ALIAS} is currently bound to "${existingCommand}"; confirming will remove this custom binding.`,
    existingCommand
  };
}

function renderCodexMcpBlock(): string {
  return [
    "[mcp_servers.alaya]",
    `command = ${JSON.stringify(ALAYA_MCP_COMMAND)}`,
    `args = ${JSON.stringify([...ALAYA_MCP_ARGS])}`,
    `operator_instructions = ${JSON.stringify(ALAYA_OPERATOR_INSTRUCTIONS)}`
  ].join("\n");
}

function renderCodexSlashBlock(): string {
  return [
    "[slash_commands.alaya-inspect]",
    `command = ${JSON.stringify(ALAYA_SLASH_COMMAND)}`,
    `description = ${JSON.stringify("Open the Alaya Memory Inspector.")}`
  ].join("\n");
}

async function detectActivePath(fs: ProfileMutationFs, candidates: readonly string[]): Promise<string> {
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

function uniqueNonEmptyPaths(paths: readonly (string | undefined)[]): readonly string[] {
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

function parseJsonObject(content: string | undefined, label: string): Record<string, unknown> {
  if (content === undefined || content.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("must contain a JSON object");
    }
    return { ...parsed };
  } catch (error) {
    throw new ProfileMutationError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      65
    );
  }
}

function appendTomlBlock(content: string, block: string): string {
  const trimmed = content.trimEnd();
  return `${trimmed.length === 0 ? "" : `${trimmed}\n\n`}${block}\n`;
}

function removeTomlBlock(content: string, header: string): string {
  const lines = content.split(/\r?\n/gu);
  const nextLines: string[] = [];
  let skipping = false;
  let removedAny = false;

  for (const line of lines) {
    if (line.trim() === header) {
      skipping = true;
      removedAny = true;
      continue;
    }

    if (skipping && /^\s*\[[^\]]+\]\s*$/u.test(line)) {
      skipping = false;
    }

    if (!skipping) {
      nextLines.push(line);
    }
  }

  if (!removedAny) {
    return content;
  }

  return `${nextLines.join("\n").trimEnd()}\n`;
}

function extractTomlBlock(content: string, header: string): string | undefined {
  const lines = content.split(/\r?\n/gu);
  const block: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (line.trim() === header) {
      collecting = true;
    } else if (collecting && /^\s*\[[^\]]+\]\s*$/u.test(line)) {
      break;
    }
    if (collecting) {
      block.push(line);
    }
  }
  return block.length === 0 ? undefined : block.join("\n");
}

function extractCodexSlashCommand(content: string): string | undefined {
  const block = extractTomlBlock(content, "[slash_commands.alaya-inspect]");
  if (block === undefined) {
    return undefined;
  }
  const match = /^\s*command\s*=\s*"([^"]*)"\s*$/mu.exec(block);
  return match?.[1];
}

function requireHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (home === undefined || home.trim().length === 0) {
    throw new ProfileMutationError("HOME is required to resolve profile paths.", 66);
  }
  return home;
}

function readSingleLine(stream: NodeJS.ReadableStream): Promise<string> {
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

function normalizeFileText(content: string | undefined): string {
  return (content ?? "").replace(/\r\n/gu, "\n").trimEnd();
}

function indentBlock(content: string): string {
  return content
    .split(/\r?\n/gu)
    .map((line) => `  ${line}`)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
