import type { SourceSemanticResourceBudget } from "../garden/source-semantic-resources.js";
import type { SourceIndexProfile, SourceIndexResources, SourceIndexTarget } from "./source-index.js";

/** Private acquisition input, not an MCP vector input or an inference-usage receipt. */
export type SourceIndexQueryVector = Readonly<{
  status: "available"; profile: SourceIndexProfile; profile_id: string;
  input_digest: string; embedding: Float32Array;
}> | Readonly<{ status: "unavailable"; reason: string }>;

/** One total allowance. There are no implicit per-channel quotas or refill allowances. */
export type SourceIndexNominationAllowance = Readonly<{
  max_attempts: number; max_roots: number; max_vector_windows: number;
}>;
export type SourceIndexQueryResources = SourceIndexResources & Readonly<{
  /** Includes returned native bytes, decoded vectors and logical retention; not process RSS. */
  memory_bytes: number;
  /** LIMIT and indexed seeks do not bound SQLite posting comparisons, sorting, I/O or CPU. */
  sql_internal_work: "unknown";
}>;
export type SourceIndexQueryCompletion = "complete" | "partial" | "unavailable" | "not_run";
export type SourceIndexVectorBinding = Readonly<{
  workspace_id: string; selection_revision: number; config_id: string; profile_id: string;
  generation_id: string; source_epoch: number; dimensions: number;
}>;
export type SourceIndexVectorQueryState = Readonly<{
  status: "ready" | "partial" | "valid_empty"; binding: SourceIndexVectorBinding;
}> | Readonly<{ status: "unknown" | "unbound" | "unavailable"; reason: string }>;
export type SourceIndexVectorCursor = Readonly<{
  binding: SourceIndexVectorBinding; after_window_id: string;
}>;
export type SourceIndexLexicalRank = Readonly<{
  rank: number; lane: "unicode61" | "trigram"; lane_rank: number; bm25: number;
}>;
export type SourceIndexLexicalCandidate = Readonly<{
  source: SourceIndexTarget; lexical: SourceIndexLexicalRank;
}>;
export type SourceIndexQueryWindow = Readonly<{
  window_id: string; start_byte: number; end_byte: number; content_digest: string;
}>;
export type SourceIndexVectorCandidate = Readonly<{
  source: SourceIndexTarget; window: SourceIndexQueryWindow; embedding: Float32Array;
}>;
type SourceIndexQueryResourceRefusal = Readonly<{
  stage: "input" | "lexical" | "vector" | "admission" | "nomination"; phase: string;
}>;
/** Separate from the navigation-text digest: binds the actual terms and captured segmenter state. */
type SourceIndexLexicalTokenization = Readonly<{
  policy: "source-index-fts.v1"; binding_digest: string;
  cjk_state: "uninitialized" | "loading" | "ready" | "unavailable";
  terms: readonly string[]; unicode61_terms: readonly string[]; trigram_terms: readonly string[];
}>;
export type SourceIndexLexicalRead = Readonly<{
  candidates: readonly SourceIndexLexicalCandidate[]; completion: SourceIndexQueryCompletion;
  reason: string | null; resources: SourceIndexQueryResources;
  /** Null means tokenization did not finish, not an empty query. */
  tokenization: SourceIndexLexicalTokenization | null;
  resource_refusal: SourceIndexQueryResourceRefusal | null;
  /** Text publication has no complete-corpus activation pointer. */
  index_coverage: "partial";
  limitations: readonly string[];
}>;
export type SourceIndexVectorRead = Readonly<{
  candidates: readonly SourceIndexVectorCandidate[]; completion: SourceIndexQueryCompletion;
  reason: string | null; resources: SourceIndexQueryResources; state: SourceIndexVectorQueryState;
  resource_refusal: SourceIndexQueryResourceRefusal | null;
  cursor: SourceIndexVectorCursor | null; inspected: number; invalid: number;
}>;
export type SourceIndexQueryAdmission = Readonly<{ resources: SourceIndexQueryResources }> & (
  Readonly<{ status: "ready"; scope_class: string | null }> |
  Readonly<{ status: "stale" | "partial" | "unbound"; reason: string }> |
  Readonly<{ status: "resource_limited"; reason: "read_budget"; phase: string }>
);

/** The daemon must delegate to authorizeSemanticScope. Denied roots are skipped, not native unknowns.
 * There is deliberately no unrestricted default. The callback must not perform unmetered native reads.
 */
export type SourceIndexScopeAdmission = (scopeClass: string | null, source: SourceIndexTarget) => "admitted" | "denied";

/** Mechanical reads behind Core acquisition; no caller-selected generation or ANN authority. */
export interface SourceIndexQueryRepository {
  readLexicalCandidates(workspaceId: string, navigationText: string, limit: number,
    budget: SourceSemanticResourceBudget): SourceIndexLexicalRead;
  readVectorCandidates(workspaceId: string, cursor: SourceIndexVectorCursor | null, limit: number,
    budget: SourceSemanticResourceBudget): SourceIndexVectorRead;
  /** A vector binding is only a comparison against the actual selected active pointer, never a read selector. */
  admitQueryCandidate(source: SourceIndexTarget, vectorBinding: SourceIndexVectorBinding | null,
    budget: SourceSemanticResourceBudget): SourceIndexQueryAdmission;
}
export type SourceIndexRootNomination = Readonly<{
  source: SourceIndexTarget; lexical: readonly SourceIndexLexicalRank[];
  vector: Readonly<{ rank: number; cosine: number; window: SourceIndexQueryWindow }> | null;
}>;
export type SourceIndexNominationAccounting = Readonly<{
  attempted: number; admitted: number; duplicate: number; rejected: number;
  scope_denied: number; native_unknown: number; resource_refused: number; stale: number; nomination_limit: number;
}>;
export type SourceIndexAcquisitionInput = Readonly<{
  workspace_id: string; navigation_text: string; vector: SourceIndexQueryVector;
  allowance: SourceIndexNominationAllowance; budget: SourceSemanticResourceBudget;
}>;
export type SourceIndexAcquisitionResult = Readonly<{
  policy: "source-index-interleaved-prefix.v1";
  navigation_digest: string | null;
  /** Completion of this bounded schedule, never a successful source-absence certificate. */
  completion: SourceIndexQueryCompletion;
  nominations: readonly SourceIndexRootNomination[];
  accounting: SourceIndexNominationAccounting; resources: SourceIndexQueryResources;
  resource_refusals: readonly SourceIndexQueryResourceRefusal[];
  lexical: Readonly<{ completion: SourceIndexQueryCompletion; index_coverage: "partial";
    reason: string | null; limitations: readonly string[]; tokenization: SourceIndexLexicalTokenization | null }>;
  vector: Readonly<{ completion: SourceIndexQueryCompletion; state: SourceIndexVectorQueryState | null;
    reason: string | null; inspected_windows: number; invalid_windows: number;
    /** Available input is supplied/prepared, not necessarily validated by this acquisition. */
    validation: "not_run" | "validated" | "invalid" | "not_applicable";
    ranking: "exact_over_inspected_subset";
    input: Readonly<{ status: "available"; profile_id: string; input_digest: string }> |
      Readonly<{ status: "unavailable"; reason: string }> }>;
  limitations: readonly string[];
}>;
