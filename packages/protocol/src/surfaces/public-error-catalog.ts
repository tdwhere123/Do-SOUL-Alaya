export const PUBLIC_ERROR_CODES = [
  "UNKNOWN_TOOL",
  "VALIDATION",
  "UNAVAILABLE",
  "NOT_FOUND",
  "NEEDS_CONTEXT",
  "INTERNAL"
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export const PUBLIC_ERROR_CODE_MESSAGES = Object.freeze({
  UNKNOWN_TOOL: "Unsupported Alaya memory tool.",
  VALIDATION: "Invalid request.",
  UNAVAILABLE: "Tool is unavailable.",
  NOT_FOUND: "Resource not found.",
  NEEDS_CONTEXT: "Additional context is required.",
  INTERNAL: "MCP memory tool call failed."
} as const satisfies Readonly<Record<PublicErrorCode, string>>);

export type PublicErrorCodeMessage = (typeof PUBLIC_ERROR_CODE_MESSAGES)[PublicErrorCode];

// Closed workflow copy. Interpolated IDs, Zod `received`, and thrown
// Error.message are not public; callers must map through this list.
const PUBLIC_ERROR_WORKFLOW_MESSAGES = [
  "Pointer object not found.",
  "Proposal not found.",
  "Proposal not found in current workspace/run context.",
  "Target memory object not found.",
  "Target memory object not found in workspace.",
  "source_delivery_ids contains an unknown or out-of-scope delivery_id.",
  "source_delivery_ids require a source delivery anchor validator.",
  "soul.emit_candidate_signal requires a runId in the MCP call context.",
  "soul.apply_override requires a run context.",
  "soul.resolve is not wired into this daemon",
  "Memory proposal workflow is not available.",
  "Edge proposal service is not available.",
  "Memory update proposal requires proposed_changes.",
  "reviewer binding not configured",
  "Review requires a human reviewer surface (Inspector/alaya review); attached agents cannot review.",
  "Invalid reviewer token.",
  "Reviewer identity does not match server-bound reviewer.",
  "Proposal is assigned to a different reviewer.",
  "Proposal is already accepted",
  "Proposal is already rejected",
  "Proposal is already expired",
  "Proposal is already superseded",
  "Proposal is already auto_applied",
  "Atomic privacy erase acceptance is unavailable.",
  "Privacy erase acceptance omitted its mutation.",
  "used_object_ids can only be supplied when usage_state is used.",
  "used_object_ids contradict delivered_objects usage_status values.",
  "source_evidence usage requires a tagged target.",
  "source_evidence usage requires a source_evidence target.",
  "source_evidence usage must not fill object_id.",
  "source_evidence target or span does not match the current retained source.",
  "Used target workspace does not match the current workspace.",
  "Garden task queue is not available.",
  "Garden task not found.",
  "Garden task is not in claimed state; claim it via garden.claim_task before completing.",
  "Garden task is claimed by a different agent target; only the claimant may complete it.",
  "Garden task is an edge_classify task; complete it with result_envelope.edge_verdict, not candidate_signals.",
  "Garden task does not accept an edge_verdict; that result shape is only valid for edge_classify tasks.",
  "Garden task candidate_signals changed after a previous partial completion attempt; retry with the original candidate signal envelope.",
  "Garden task claim changed before candidate signal emission; retry after claiming the task again.",
  "Garden task is an edge_classify task completed without a result_envelope.edge_verdict; report edge_type \"none\" for an explicit no-edge decision, or complete with status \"failed\" if no verdict can be produced.",
  "Garden task edge_verdict pair does not match the claimed task's source/neighbor memory pair.",
  "Garden task has malformed EDGE_CLASSIFY payload; cannot apply host-worker verdict.",
  "Garden task post-turn payload escaped the claimed workspace or run.",
  "Garden task completion claim changed before candidate signal emission.",
  "Garden task evidence fallback did not create durable evidence.",
  "Garden task evidence fallback source content was empty.",
  "garden.complete_task cannot emit candidate_signals without a run_id in the task payload or MCP call context.",
  "garden.complete_task cannot finalize post-turn evidence without a durable signal receiver.",
  "garden.complete_task received an edge_verdict but no edge-classification applier is wired.",
  "garden.complete_task does not support result_envelope.extracted_proposals yet.",
  "invalid JSON body",
  "text is required",
  "invalid datetime",
  "time_field must be 'created_at' or 'last_used_at'"
] as const;

export const PUBLIC_ERROR_MESSAGES = Object.freeze([
  ...Object.values(PUBLIC_ERROR_CODE_MESSAGES),
  ...PUBLIC_ERROR_WORKFLOW_MESSAGES
] as const);

export type PublicErrorMessage = (typeof PUBLIC_ERROR_MESSAGES)[number];

const PUBLIC_ERROR_CODE_SET: ReadonlySet<string> = new Set(PUBLIC_ERROR_CODES);
const PUBLIC_ERROR_MESSAGE_SET: ReadonlySet<string> = new Set(PUBLIC_ERROR_MESSAGES);

export interface PublicToolError {
  readonly code: PublicErrorCode;
  readonly message: string;
}

export interface PublicStructuredErrorEnvelope {
  readonly success: false;
  readonly error: PublicToolError;
}

export function isPublicErrorCode(code: string): code is PublicErrorCode {
  return PUBLIC_ERROR_CODE_SET.has(code);
}

export function isPublicErrorMessage(message: string): boolean {
  return PUBLIC_ERROR_MESSAGE_SET.has(message);
}

export function resolvePublicErrorMessage(code: string, candidate?: string): string {
  const resolvedCode = isPublicErrorCode(code) ? code : "INTERNAL";
  if (candidate !== undefined) {
    const matched = matchPublicErrorMessage(candidate);
    if (matched !== undefined) {
      return matched;
    }
  }
  return PUBLIC_ERROR_CODE_MESSAGES[resolvedCode];
}

export function toPublicToolError(code: string, candidate?: string): PublicToolError {
  const resolvedCode = isPublicErrorCode(code) ? code : "INTERNAL";
  return Object.freeze({
    code: resolvedCode,
    message: resolvePublicErrorMessage(resolvedCode, candidate)
  });
}

export function publicStructuredErrorEnvelope(
  code: string,
  candidate?: string
): PublicStructuredErrorEnvelope {
  return Object.freeze({
    success: false,
    error: toPublicToolError(code, candidate)
  });
}

export function readPublicStructuredErrorEnvelope(
  payload: unknown
): PublicStructuredErrorEnvelope | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as { readonly success?: unknown; readonly error?: unknown };
  if (candidate.success !== false) {
    return null;
  }
  const error = candidate.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }
  const errorObject = error as { readonly code?: unknown; readonly message?: unknown };
  if (typeof errorObject.code !== "string" || typeof errorObject.message !== "string") {
    return null;
  }
  if (!isPublicErrorCode(errorObject.code) || !isPublicErrorMessage(errorObject.message)) {
    return null;
  }
  return Object.freeze({
    success: false as const,
    error: Object.freeze({
      code: errorObject.code,
      message: errorObject.message
    })
  });
}

function matchPublicErrorMessage(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (PUBLIC_ERROR_MESSAGE_SET.has(trimmed)) {
    return trimmed;
  }
  let best: string | undefined;
  for (const allowed of PUBLIC_ERROR_MESSAGES) {
    const stem = publicErrorStem(allowed);
    if (stem.length === 0) {
      continue;
    }
    if (
      trimmed === stem ||
      trimmed.startsWith(`${stem}:`) ||
      trimmed.startsWith(`${stem};`) ||
      trimmed.startsWith(`${stem} `)
    ) {
      if (best === undefined || allowed.length > best.length) {
        best = allowed;
      }
    }
  }
  return best;
}

function publicErrorStem(message: string): string {
  return message.endsWith(".") ? message.slice(0, -1) : message;
}
