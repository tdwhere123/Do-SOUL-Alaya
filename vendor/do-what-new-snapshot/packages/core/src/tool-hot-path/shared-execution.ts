import path from "node:path";
import type {
  EventLogEntry,
  ToolCallCompletedPayload,
  ToolCallStartedPayload,
  ToolExecutionRecord,
  ToolPermissionResult,
  ToolSpec
} from "@do-what/protocol";
import {
  PhaseA1EventType,
  ToolCallCompletedPayloadSchema,
  ToolExecutionRecordSchema
} from "@do-what/protocol";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { ToolExecutionContext } from "../tool-substrate/index.js";

export const CURRENT_TOOL_EVENT_REVISION = 0;

const BUILTIN_WRITE_FILE_TOOL_ID = "tools.write_file";
const EXTERNAL_FILESYSTEM_WRITE_FILE_TOOL_ID = "mcp__filesystem__write_file";

export function createToolCallEventEntry(
  eventType: EventLogEntry["event_type"],
  context: Readonly<ToolExecutionContext>,
  executionId: string,
  requestedBy: "principal" | "worker",
  requestingRunId: string,
  payload: ToolCallStartedPayload | ToolCallCompletedPayload
): Omit<EventLogEntry, "event_id" | "created_at"> {
  return {
    event_type: eventType,
    entity_type: "tool_execution",
    entity_id: executionId,
    workspace_id: context.workspaceId,
    run_id: context.sessionConfig.run_id ?? (requestedBy === "principal" ? requestingRunId : null),
    caused_by: requestedBy,
    revision: CURRENT_TOOL_EVENT_REVISION,
    payload_json: payload
  };
}

export function buildToolExecutionRecord(input: {
  readonly executionId: string;
  readonly toolSpec: Readonly<ToolSpec>;
  readonly requestedBy: "principal" | "worker";
  readonly requestingRunId: string;
  readonly governanceDecisionRef: string;
  readonly permissionResult: ToolPermissionResult;
  readonly executed: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly resultSummary?: string;
  readonly affectedPaths?: readonly string[] | null;
}): Readonly<ToolExecutionRecord> {
  return deepFreeze(
    ToolExecutionRecordSchema.parse({
      execution_id: input.executionId,
      tool_id: input.toolSpec.tool_id,
      requested_by: input.requestedBy,
      requesting_run_id: input.requestingRunId,
      governance_decision_ref: input.governanceDecisionRef,
      permission_result: input.permissionResult,
      executed: input.executed,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      result_summary: input.resultSummary,
      rollback_status: "none",
      post_effect_refs: [],
      ...(input.affectedPaths === undefined ? {} : { affected_paths: input.affectedPaths })
    })
  );
}

export function resolveAffectedPaths(input: {
  readonly context: Readonly<ToolExecutionContext>;
  readonly toolSpec: Readonly<ToolSpec>;
  readonly rawInput: unknown;
  readonly outcome: unknown;
}): readonly string[] | undefined {
  if (!supportsAffectedPaths(input.toolSpec.tool_id)) {
    return undefined;
  }

  if (!isSuccessfulAffectedPathOutcome(input.toolSpec.tool_id, input.outcome)) {
    return undefined;
  }

  const rawPath = readPathInput(input.rawInput);

  if (rawPath === null) {
    return undefined;
  }

  const normalizedPath = normalizeWorkspaceRelativePath(rawPath, input.context.affectedPathRoots);
  return normalizedPath === null ? undefined : [normalizedPath];
}

export function summarizeValue(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (value === null) {
    return `${fallback}: null`;
  }

  if (value === undefined) {
    return `${fallback}: undefined`;
  }

  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string" && serialized.length > 0) {
      return serialized;
    }
  } catch {
    // Fall through to a generic summary.
  }

  if (Array.isArray(value)) {
    return `${fallback}: array(${value.length})`;
  }

  if (typeof value === "object") {
    const constructorName = value.constructor?.name?.trim();
    return constructorName ? `${fallback}: ${constructorName}` : fallback;
  }

  return fallback;
}

export function truncateSummary(summary: string, maxLength = 200): string {
  return summary.slice(0, maxLength);
}

export function summarizeForEvent(value: unknown, fallback: string, maxLength = 200): string {
  return truncateSummary(summarizeValue(value, fallback), maxLength);
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }

  return summarizeValue(error, "Tool execution failed");
}

export function summarizeErrorForEvent(error: unknown, maxLength = 200): string {
  return truncateSummary(summarizeError(error), maxLength);
}

export function calculateDurationMs(startedAt: string, endedAt: string): number {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

export async function emitCompletedToolExecution(input: {
  readonly eventLogRepo: {
    append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  };
  readonly executionRecordRepo: {
    insert(record: ToolExecutionRecord): Promise<Readonly<ToolExecutionRecord>>;
  };
  readonly sseBroadcaster: {
    broadcastEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly context: Readonly<ToolExecutionContext>;
  readonly executionId: string;
  readonly requestedBy: "principal" | "worker";
  readonly requestingRunId: string;
  readonly toolSpec: Readonly<ToolSpec>;
  readonly governanceDecisionRef: string;
  readonly permissionResult: ToolPermissionResult;
  readonly affectedPaths?: readonly string[] | null;
  readonly endedAt: string;
  readonly statusKind: "success" | "error";
  readonly outcome: unknown;
}): Promise<{
  readonly completedEntry: EventLogEntry;
  readonly completedPayload: ToolCallCompletedPayload;
  readonly executionRecord: Readonly<ToolExecutionRecord>;
}> {
  const completedPayload = deepFreeze(
    ToolCallCompletedPayloadSchema.parse({
      toolCallId: input.executionId,
      statusKind: input.statusKind,
      outputSummary:
        input.statusKind === "success"
          ? summarizeForEvent(input.outcome, "tool output")
          : summarizeErrorForEvent(input.outcome),
      durationMs: calculateDurationMs(input.context.startedAt, input.endedAt),
      ...(input.affectedPaths === undefined ? {} : { affected_paths: input.affectedPaths })
    })
  );
  const completedEntry = await input.eventLogRepo.append(
    createToolCallEventEntry(
      PhaseA1EventType.TOOL_CALL_COMPLETED,
      input.context,
      input.executionId,
      input.requestedBy,
      input.requestingRunId,
      completedPayload
    )
  );
  const executionRecord = await input.executionRecordRepo.insert(
    buildToolExecutionRecord({
      executionId: input.executionId,
      toolSpec: input.toolSpec,
      requestedBy: input.requestedBy,
      requestingRunId: input.requestingRunId,
      governanceDecisionRef: input.governanceDecisionRef,
      permissionResult: input.permissionResult,
      executed: true,
      startedAt: input.context.startedAt,
      endedAt: input.endedAt,
      resultSummary: completedPayload.outputSummary,
      affectedPaths: input.affectedPaths
    })
  );
  await input.sseBroadcaster.broadcastEntry(completedEntry);

  return {
    completedEntry,
    completedPayload,
    executionRecord
  };
}

export function rethrowWithSuppressedError(primaryError: unknown, secondaryError: unknown): never {
  throw new ToolExecutionSideEffectError(primaryError, secondaryError);
}

function supportsAffectedPaths(toolId: string): toolId is
  | typeof BUILTIN_WRITE_FILE_TOOL_ID
  | typeof EXTERNAL_FILESYSTEM_WRITE_FILE_TOOL_ID {
  return toolId === BUILTIN_WRITE_FILE_TOOL_ID || toolId === EXTERNAL_FILESYSTEM_WRITE_FILE_TOOL_ID;
}

function isSuccessfulAffectedPathOutcome(
  toolId: typeof BUILTIN_WRITE_FILE_TOOL_ID | typeof EXTERNAL_FILESYSTEM_WRITE_FILE_TOOL_ID,
  value: unknown
): boolean {
  if (toolId === BUILTIN_WRITE_FILE_TOOL_ID) {
    return isSuccessfulBuiltinWriteFileResult(value);
  }

  return isSuccessfulExternalFilesystemWriteResult(value);
}

function isSuccessfulBuiltinWriteFileResult(value: unknown): value is { readonly ok: true } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

function isSuccessfulExternalFilesystemWriteResult(value: unknown): boolean {
  return isSuccessfulBuiltinWriteFileResult(value) || isSuccessfulMcpToolResult(value);
}

function isSuccessfulMcpToolResult(
  value: unknown
): value is { readonly content: readonly unknown[]; readonly structuredContent?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !isStructuredToolErrorResult(value) &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function isStructuredToolErrorResult(value: unknown): value is { readonly ok: false } {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function readPathInput(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("path" in value)) {
    return null;
  }

  return typeof value.path === "string" && value.path.length > 0 ? value.path : null;
}

function normalizeWorkspaceRelativePath(rawPath: string, writableRoots: readonly string[]): string | null {
  const normalizedRoots = writableRoots.map((root) => path.resolve(root));

  if (normalizedRoots.length === 0) {
    return null;
  }

  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(normalizedRoots[0]!, rawPath);
  const root = normalizedRoots.find((candidateRoot) => isPathWithinRoot(resolvedPath, candidateRoot));

  if (root === undefined) {
    return null;
  }

  const relativePath = path.relative(root, resolvedPath);
  return relativePath.length === 0 ? null : relativePath.split(path.sep).join(path.posix.sep);
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

class ToolExecutionSideEffectError extends Error {
  public readonly secondaryError: unknown;

  public constructor(primaryError: unknown, secondaryError: unknown) {
    super(
      primaryError instanceof Error ? primaryError.message : String(primaryError),
      { cause: primaryError }
    );
    this.name = "ToolExecutionSideEffectError";
    this.secondaryError = secondaryError;
  }
}
