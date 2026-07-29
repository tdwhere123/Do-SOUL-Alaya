import { join } from "node:path";
import {
  ALAYA_OPERATOR_INSTRUCTIONS,
  ALAYA_SLASH_ALIAS,
  PROFILE_MUTATION_CONFIRM_PROMPT,
  SUPPORTED_PROFILE_TARGETS
} from "./profile-mutation-constants.js";
import { createNodeProfileMutationFs } from "./profile-mutation-fs.js";
import { resolveAlayaSlashCommand } from "./profile-mutation-launcher.js";
import {
  detectActivePath,
  readSingleLine,
  removeMcpEntry,
  removeSlashAlias,
  requireHome,
  restoreOperationBefore,
  uniqueNonEmptyPaths,
  upsertMcpEntry,
  upsertSlashAlias
} from "./profile-mutation-operations.js";
import {
  ProfileMutationError,
  type ProfileMutationApplyOptions,
  type ProfileMutationApplyResult,
  type ProfileMutationAuditRow,
  type ProfileMutationBuildOptions,
  type ProfileMutationConfirmIo,
  type ProfileMutationOperation,
  type ProfileMutationPlan,
  type ProfilePaths,
  type ProfileTarget,
  type ResolveProfilePathsOptions
} from "./profile-mutation-types.js";
import { extractTomlBlock, indentBlock, isRecord, normalizeFileText, parseJsonObject } from "./profile-mutation-text.js";

export type {
  ProfileMutationApplyOptions,
  ProfileMutationApplyResult,
  ProfileMutationAuditRecord,
  ProfileMutationAuditRow,
  ProfileMutationAuditWriter,
  ProfileMutationBuildOptions,
  ProfileMutationConfirmIo,
  ProfileMutationConflict,
  ProfileMutationDirection,
  ProfileMutationFs,
  ProfileMutationOperation,
  ProfileMutationPlan,
  ProfilePaths,
  ProfileTarget,
  ResolveProfilePathsOptions
} from "./profile-mutation-types.js";
export { ProfileMutationError } from "./profile-mutation-types.js";
export {
  ALAYA_LEGACY_SLASH_COMMAND,
  ALAYA_MCP_ARGS,
  ALAYA_MCP_COMMAND,
  ALAYA_OPERATOR_INSTRUCTIONS,
  ALAYA_SLASH_ALIAS,
  ALAYA_SLASH_ARGS,
  PROFILE_MUTATION_CONFIRM_PROMPT,
  PUBLIC_SOUL_TOOL_NAMES,
  SUPPORTED_PROFILE_TARGETS
} from "./profile-mutation-constants.js";
export { createNodeProfileMutationFs } from "./profile-mutation-fs.js";
export { resolveAlayaMcpLauncher, resolveAlayaSlashCommand } from "./profile-mutation-launcher.js";

export const ALAYA_SLASH_COMMAND = resolveAlayaSlashCommand();

export type ProfileInstructionsDriftStatus =
  | "absent"
  | "in_sync"
  | "drifted";

export interface ProfileInstructionsDriftReport {
  readonly target: ProfileTarget;
  readonly profile_path: string;
  readonly status: ProfileInstructionsDriftStatus;
  readonly attached_preview: string | null;
}

export function extractAttachedOperatorInstructions(
  target: ProfileTarget,
  content: string | undefined
): string | undefined {
  if (content === undefined || content.trim().length === 0) {
    return undefined;
  }
  if (target === "codex") {
    const block = extractTomlBlock(content, "[mcp_servers.alaya]");
    if (block === undefined) {
      return undefined;
    }
    const match = /^\s*operator_instructions\s*=\s*(".*")\s*$/mu.exec(block);
    if (match === null) {
      return undefined;
    }
    const encodedInstructions = match[1];
    if (encodedInstructions === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(encodedInstructions) as string;
    } catch {
      return undefined;
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(content, ".claude.json");
  } catch {
    return undefined;
  }
  const mcpServers = parsed.mcpServers;
  if (!isRecord(mcpServers)) {
    return undefined;
  }
  const alayaEntry = mcpServers.alaya;
  if (!isRecord(alayaEntry)) {
    return undefined;
  }
  const value = alayaEntry.operatorInstructions;
  return typeof value === "string" ? value : undefined;
}

export function extractAttachedAgentTarget(
  target: ProfileTarget,
  content: string | undefined
): string | undefined {
  if (content === undefined || content.trim().length === 0) {
    return undefined;
  }
  if (target === "codex") {
    const block = extractTomlBlock(content, "[mcp_servers.alaya]");
    if (block === undefined) {
      return undefined;
    }
    const match = /\bALAYA_AGENT_TARGET\s*=\s*"([^"]*)"/u.exec(block);
    return match === null ? undefined : match[1];
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(content, ".claude.json");
  } catch {
    return undefined;
  }
  const alayaEntry = isRecord(parsed.mcpServers) ? parsed.mcpServers.alaya : undefined;
  const entryEnv = isRecord(alayaEntry) ? alayaEntry.env : undefined;
  const value = isRecord(entryEnv) ? entryEnv.ALAYA_AGENT_TARGET : undefined;
  return typeof value === "string" ? value : undefined;
}

export async function detectAttachedProfileInstructionsDrift(
  target: ProfileTarget,
  options: ProfileMutationBuildOptions = {}
): Promise<ProfileInstructionsDriftReport> {
  const env = options.env ?? process.env;
  const fs = options.fs ?? createNodeProfileMutationFs();
  const paths = await resolveProfilePaths(target, { env, fs });
  const content = await fs.readText(paths.mcpConfigPath);
  const attached = extractAttachedOperatorInstructions(target, content);
  if (attached === undefined) {
    return {
      target,
      profile_path: paths.mcpConfigPath,
      status: "absent",
      attached_preview: null
    };
  }
  if (attached !== ALAYA_OPERATOR_INSTRUCTIONS) {
    return {
      target,
      profile_path: paths.mcpConfigPath,
      status: "drifted",
      attached_preview: attached.length > 120 ? `${attached.slice(0, 119)}…` : attached
    };
  }
  const attachedAgentTarget = extractAttachedAgentTarget(target, content);
  if (attachedAgentTarget !== target) {
    return {
      target,
      profile_path: paths.mcpConfigPath,
      status: "drifted",
      attached_preview: `ALAYA_AGENT_TARGET=${attachedAgentTarget ?? "(missing)"}`
    };
  }
  return {
    target,
    profile_path: paths.mcpConfigPath,
    status: "in_sync",
    attached_preview: null
  };
}

export async function buildAttachProfileMutationPlan(
  target: ProfileTarget,
  options: ProfileMutationBuildOptions = {}
): Promise<ProfileMutationPlan> {
  const env = options.env ?? process.env;
  const fs = options.fs ?? createNodeProfileMutationFs();
  const paths = await resolveProfilePaths(target, { env, fs });
  const mcpBefore = await fs.readText(paths.mcpConfigPath);
  const slashBefore = await fs.readText(paths.slashCommandsPath);
  const mcpAfter = upsertMcpEntry(target, mcpBefore, env);
  const slashResult = upsertSlashAlias(target, slashBefore, env);

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
  const env = options.env ?? process.env;
  const fs = options.fs ?? createNodeProfileMutationFs();
  const paths = await resolveProfilePaths(target, { env, fs });
  const mcpBefore = await fs.readText(paths.mcpConfigPath);
  const slashBefore = await fs.readText(paths.slashCommandsPath);
  const mcpRemoval = removeMcpEntry(target, mcpBefore);
  const slashRemoval = removeSlashAlias(target, slashBefore, env);

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
  assertProfileMutationConflictsAllowed(plan, options.allowConflicts ?? false);
  const changedOperations = plan.operations.filter((operation) => operation.changed);
  if (changedOperations.length === 0) {
    return { changed: false, auditRow: undefined };
  }

  const auditRow = buildProfileMutationAuditRow(plan, changedOperations, options.nowIso);
  const auditWriter = options.auditWriter;
  const auditBeforeWrite = auditWriter !== undefined && typeof auditWriter.rollback === "function";
  let auditWritten = await writeProfileMutationAuditBeforeApply(auditWriter, auditBeforeWrite, auditRow);
  const applied: ProfileMutationOperation[] = [];
  try {
    await applyChangedProfileMutationOperations(fs, changedOperations, applied);
    if (!auditWritten && auditWriter !== undefined) {
      await auditWriter.append(auditRow);
      auditWritten = true;
    }
  } catch (error) {
    await rollbackAppliedProfileMutation(fs, applied, auditWritten, auditWriter, auditRow);
    throw error;
  }

  return { changed: true, auditRow };
}

export function parseProfileTarget(value: string): ProfileTarget | undefined {
  return SUPPORTED_PROFILE_TARGETS.find((target) => target === value);
}

function buildProfileMutationAuditRow(
  plan: ProfileMutationPlan,
  changedOperations: readonly ProfileMutationOperation[],
  nowIsoInput: (() => string) | undefined
): ProfileMutationAuditRow {
  const nowIso = nowIsoInput ?? (() => new Date().toISOString());
  return {
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
}

function assertProfileMutationConflictsAllowed(plan: ProfileMutationPlan, allowConflicts: boolean): void {
  const conflicts = plan.operations.filter((operation) => operation.conflict !== undefined);
  if (!allowConflicts && conflicts.length > 0) {
    throw new ProfileMutationError(conflicts.map((operation) => operation.conflict!.message).join("; "), 77);
  }
}

async function writeProfileMutationAuditBeforeApply(
  auditWriter: ProfileMutationApplyOptions["auditWriter"],
  auditBeforeWrite: boolean,
  auditRow: ProfileMutationAuditRow
): Promise<boolean> {
  if (auditBeforeWrite && auditWriter !== undefined) {
    await auditWriter.append(auditRow);
    return true;
  }
  return false;
}

async function applyChangedProfileMutationOperations(
  fs: ReturnType<typeof createNodeProfileMutationFs>,
  changedOperations: readonly ProfileMutationOperation[],
  applied: ProfileMutationOperation[]
): Promise<void> {
  for (const operation of changedOperations) {
    if (operation.after === undefined) {
      await fs.removeText(operation.path);
    } else {
      await fs.writeTextAtomic(operation.path, operation.after, 0o600);
    }
    applied.push(operation);
  }
}

async function rollbackAppliedProfileMutation(
  fs: ReturnType<typeof createNodeProfileMutationFs>,
  applied: ProfileMutationOperation[],
  auditWritten: boolean,
  auditWriter: ProfileMutationApplyOptions["auditWriter"],
  auditRow: ProfileMutationAuditRow
): Promise<void> {
  for (const operation of applied.reverse()) {
    await restoreOperationBefore(fs, operation);
  }
  if (auditWritten && auditWriter !== undefined && typeof auditWriter.rollback === "function") {
    await auditWriter.rollback(auditRow);
  }
}
