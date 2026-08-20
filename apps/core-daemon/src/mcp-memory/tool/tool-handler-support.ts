import { CandidateMemorySignalMemoryRefKeys } from "@do-soul/alaya-protocol";
import type { AlayaMemoryToolName } from "./tool-catalog.js";
import { McpToolError } from "./mcp-tool-error.js";
import type {
  McpMemoryToolCallResult,
  McpMemoryToolErrorCode,
  McpMemoryToolResponseByName,
  McpMemoryToolSuccessResult
} from "./tool-handler-types.js";

export {
  McpToolError,
  ToolNotFoundError,
  ToolUnavailableError,
  ToolValidationError,
  createWorkflowError
} from "./mcp-tool-error.js";
export {
  assertReviewCallerIsAllowed as assertEdgeReviewCallerIsAllowed,
  resolveReviewerIdentity as resolveEdgeReviewerIdentity
} from "../proposal/reviewer-gating.js";

export function ok<K extends AlayaMemoryToolName>(
  toolName: K,
  output: McpMemoryToolResponseByName[K]
): McpMemoryToolSuccessResult {
  return Object.freeze({
    ok: true,
    tool_name: toolName,
    output
  }) as McpMemoryToolSuccessResult;
}

export function fail(
  toolName: string,
  code: McpMemoryToolErrorCode,
  message: string
): McpMemoryToolCallResult {
  return Object.freeze({
    ok: false,
    tool_name: toolName,
    error: Object.freeze({ code, message })
  });
}

type CandidateSignalGraphRefKey = (typeof CandidateMemorySignalMemoryRefKeys)[number];
type CandidateSignalGraphRefInput = {
  readonly raw_payload: Readonly<Record<string, unknown>>;
} & Partial<Record<CandidateSignalGraphRefKey, readonly string[]>>;

// invariant: graph-edge ref hints (`source_memory_refs`,
// `supersedes_refs`, `exception_to_refs`, `contradicts_refs`,
// `incompatible_with_refs`) are first-class fields on
// `CandidateMemorySignal` (see
// `packages/protocol/src/signals/candidate-memory-signal.ts`
// CandidateMemorySignalMemoryRefKeys). The daemon does not accept
// these keys via `raw_payload`; any occurrence is logged and left in
// raw_payload unchanged. Closes the "silent double-entry" path —
// agents that want to assert graph hints MUST use the first-class
// fields, not the untyped raw_payload channel.
export function normalizeCandidateSignalGraphRefs<T extends CandidateSignalGraphRefInput>(
  input: T,
  warn: (message: string, meta: Record<string, unknown>) => void
): T {
  const offendingKeys: CandidateSignalGraphRefKey[] = [];
  for (const key of CandidateMemorySignalMemoryRefKeys) {
    if (hasOwnProperty(input.raw_payload, key)) {
      offendingKeys.push(key);
    }
  }
  if (offendingKeys.length > 0) {
    warn(
      "candidate signal raw_payload contains graph-edge ref keys; use first-class fields instead. Ignoring raw_payload entries.",
      {
        offending_keys: offendingKeys
      }
    );
  }
  return input;
}

function hasOwnProperty(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export class RecallHitTierPromotionCasMiss extends Error {
  public constructor() {
    super("Recall-hit tier promotion CAS predicate did not match.");
    this.name = "RecallHitTierPromotionCasMiss";
  }
}

export function classifyError(error: unknown): "VALIDATION" | "UNAVAILABLE" | "NOT_FOUND" | "NEEDS_CONTEXT" | "INTERNAL" {
  if (error instanceof McpToolError) {
    return classifyMcpToolErrorCode(error.code);
  }
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "VALIDATION" ||
      error.code === "UNAVAILABLE" ||
      error.code === "NOT_FOUND" ||
      error.code === "NEEDS_CONTEXT")
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name === "ZodError") {
    return "VALIDATION";
  }
  return "INTERNAL";
}

function classifyMcpToolErrorCode(
  code: McpMemoryToolErrorCode
): "VALIDATION" | "UNAVAILABLE" | "NOT_FOUND" | "NEEDS_CONTEXT" | "INTERNAL" {
  if (
    code === "VALIDATION" ||
    code === "UNAVAILABLE" ||
    code === "NOT_FOUND" ||
    code === "NEEDS_CONTEXT"
  ) {
    return code;
  }
  return "INTERNAL";
}

export function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "MCP memory tool call failed.";
}
