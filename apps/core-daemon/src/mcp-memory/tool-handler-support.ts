import { timingSafeEqual } from "node:crypto";
import {
  CandidateMemorySignalMemoryRefKeys,
  type SoulBatchReviewEdgeProposalsRequest
} from "@do-soul/alaya-protocol";
import type { AlayaMemoryToolName } from "./tool-catalog.js";
import { HUMAN_REVIEWER_AGENT_TARGETS } from "./reviewer-surfaces.js";
import type { ReviewerIdentityBinding } from "./proposal-workflow.js";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolCallResult,
  McpMemoryToolErrorCode
} from "./tool-handler-types.js";

export function ok(toolName: AlayaMemoryToolName, output: unknown): McpMemoryToolCallResult {
  return Object.freeze({ ok: true, tool_name: toolName, output });
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

export function assertEdgeReviewCallerIsAllowed(
  context: McpMemoryToolCallContext,
  binding: ReviewerIdentityBinding | undefined
): void {
  if (binding !== undefined || HUMAN_REVIEWER_AGENT_TARGETS.has(context.agentTarget)) {
    return;
  }

  throw new ToolValidationError(
    "Review requires a human reviewer surface (Inspector/alaya review) or a configured reviewer token."
  );
}

export function resolveEdgeReviewerIdentity(
  request: SoulBatchReviewEdgeProposalsRequest,
  binding: ReviewerIdentityBinding | undefined
): string {
  if (binding === undefined) {
    return request.reviewer_identity;
  }

  if (!matchesReviewerToken(request.reviewer_token, binding.token)) {
    throw new ToolValidationError("Invalid reviewer token.");
  }
  if (request.reviewer_identity !== binding.identity) {
    throw new ToolValidationError("Reviewer identity does not match server-bound reviewer.");
  }
  return binding.identity;
}

function matchesReviewerToken(providedToken: string | undefined, expectedToken: string): boolean {
  if (providedToken === undefined || providedToken.length === 0) {
    return false;
  }
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
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

export class ToolValidationError extends Error {
  public readonly code = "VALIDATION";
}

export class ToolUnavailableError extends Error {
  public readonly code = "UNAVAILABLE";
}

export class ToolNotFoundError extends Error {
  public readonly code = "NOT_FOUND";
}

export class RecallHitTierPromotionCasMiss extends Error {
  public constructor() {
    super("Recall-hit tier promotion CAS predicate did not match.");
    this.name = "RecallHitTierPromotionCasMiss";
  }
}

export function classifyError(error: unknown): "VALIDATION" | "UNAVAILABLE" | "NOT_FOUND" | "NEEDS_CONTEXT" | "INTERNAL" {
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
  if (
    error instanceof ToolValidationError ||
    (error instanceof Error && "name" in error && error.name === "ZodError")
  ) {
    return "VALIDATION";
  }
  if (error instanceof ToolUnavailableError) {
    return "UNAVAILABLE";
  }
  if (error instanceof ToolNotFoundError) {
    return "NOT_FOUND";
  }
  return "INTERNAL";
}

export function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "MCP memory tool call failed.";
}
