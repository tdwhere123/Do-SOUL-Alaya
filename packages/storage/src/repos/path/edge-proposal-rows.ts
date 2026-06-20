import {
  EdgeProposalSchema,
  EdgeProposalTriggerSourceSchema,
  MEMORY_GRAPH_EDGE_RECALL_WEIGHTS,
  MemoryGraphEdgeTypeSchema,
  type EdgeProposal
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";
import type { EdgeProposalCreateInput } from "./edge-proposal-types.js";

export interface EdgeProposalRow {
  readonly proposal_id: string;
  readonly workspace_id: string;
  readonly source_memory_id: string;
  readonly target_memory_id: string;
  readonly edge_type: string;
  readonly trigger_source: string;
  readonly confidence: number;
  readonly reason: string | null;
  readonly source_signal_id: string | null;
  readonly run_id: string | null;
  readonly status: string;
  readonly reviewer_identity: string | null;
  readonly review_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
}

export type PathIdentitySign = "positive" | "negative" | "neutral";

const POSITIVE_RECALLS_FAMILY_RELATION_KINDS = new Set([
  "recalls",
  "co_recalled",
  "shares_entity",
  "signal_graph_ref"
]);

export function parseCreateInput(input: EdgeProposalCreateInput): EdgeProposalCreateInput {
  return {
    proposal_id: parseNonEmptyString(input.proposal_id, "proposal id"),
    workspace_id: parseNonEmptyString(input.workspace_id, "workspace id"),
    source_memory_id: parseNonEmptyString(input.source_memory_id, "source memory id"),
    target_memory_id: parseNonEmptyString(input.target_memory_id, "target memory id"),
    edge_type: MemoryGraphEdgeTypeSchema.parse(input.edge_type),
    trigger_source: EdgeProposalTriggerSourceSchema.parse(input.trigger_source),
    confidence: input.confidence,
    reason: input.reason === null ? null : parseNonEmptyString(input.reason, "reason"),
    source_signal_id: input.source_signal_id === null ? null : parseNonEmptyString(input.source_signal_id, "source signal id"),
    run_id: input.run_id === null ? null : parseNonEmptyString(input.run_id, "run id"),
    created_at: parseTimestamp(input.created_at),
    expires_at: input.expires_at === null ? null : parseTimestamp(input.expires_at)
  };
}

export function parseEdgeProposalRow(row: EdgeProposalRow): EdgeProposal {
  return deepFreeze(
    EdgeProposalSchema.parse({
      proposal_id: row.proposal_id,
      workspace_id: row.workspace_id,
      source_memory_id: row.source_memory_id,
      target_memory_id: row.target_memory_id,
      edge_type: row.edge_type,
      trigger_source: row.trigger_source,
      confidence: row.confidence,
      reason: row.reason,
      source_signal_id: row.source_signal_id,
      run_id: row.run_id,
      status: row.status,
      reviewer_identity: row.reviewer_identity,
      review_reason: row.review_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at
    })
  );
}

export function edgeProposalPathIdentity(edgeTypeValue: string): {
  readonly relationKind: EdgeProposal["edge_type"];
  readonly sign: PathIdentitySign;
  readonly isPositiveRecallsFamily: boolean;
} {
  const relationKind = parseEdgeTypeForIdentity(edgeTypeValue);
  const weight = MEMORY_GRAPH_EDGE_RECALL_WEIGHTS[relationKind];
  const sign: PathIdentitySign = weight > 0 ? "positive" : weight < 0 ? "negative" : "neutral";

  return {
    relationKind,
    sign,
    isPositiveRecallsFamily: sign === "positive" && POSITIVE_RECALLS_FAMILY_RELATION_KINDS.has(relationKind)
  };
}

export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    if (typeof codeValue === "string" && codeValue.startsWith("SQLITE_CONSTRAINT")) {
      return true;
    }
    const messageValue = (current as { readonly message?: unknown }).message;
    if (typeof messageValue === "string" && messageValue.includes("UNIQUE constraint failed")) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

function parseEdgeTypeForIdentity(value: string): EdgeProposal["edge_type"] {
  try {
    return MemoryGraphEdgeTypeSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate edge proposal edge_type: ${value}`, error);
  }
}
