import type { SourceSemanticResourceBudget } from "../garden/source-semantic-resources.js";
import type { QuestionTimePreference } from "./conditional-field/question-time.js";
import type { SourceTemplateProposal } from "./conditional-field/source-template.js";
import type { BoundSourceStatement } from "../garden/source-statements.js";
import type { SourceIndexProfile, SourceIndexTarget } from "./source-index.js";
import { SourceSemanticAcquisitionSchema, type SourceSemanticAcquisition } from "../garden/source-semantic-phase-semantics.js";
import type { HostOccurrence, HostOccurrenceInventory } from "../conversation/host-occurrence.js";
import type { HostSourceDependency } from "../conversation/host-source-dependency.js";

export type SourceIndexHostDependencyReference = Omit<HostSourceDependency, "occurrence_id" | "source_id"> & { source_id?: string };
export type SourceIndexHostDependencyRead = Readonly<{ resources: SourceIndexQueryResources }> & (
  Readonly<{ status: "ready"; source: SourceIndexTarget; inventory: HostOccurrenceInventory;
    occurrence?: HostOccurrence; text?: string; content_span?: readonly [number, number]; content_complete?: boolean }> |
  Readonly<{ status: "unknown" | "unavailable" | "denied" | "invalid" | "resource_limited"; reason: string }>
);

/** Private acquisition input, not an MCP vector input or an inference-usage receipt. */
export type SourceIndexQueryVector = Readonly<{
  status: "available"; profile: SourceIndexProfile; profile_id: string;
  input_digest: string; embedding: Float32Array;
}> | Readonly<{ status: "unavailable"; reason: string }>;

/** One total allowance. There are no implicit per-channel quotas or refill allowances. */
export type SourceIndexNominationAllowance = Readonly<{
  max_attempts: number; max_roots: number; max_vector_windows: number;
}>;
/** Snapshot-local native read capacity; quotation is separate from measured consumption. */
export type SourceIndexQueryCapacity = Readonly<{
  budget: SourceSemanticResourceBudget;
  resources: SourceIndexQueryResources;
  vector_windows: number;
  dimensions: number;
  root_key_bytes: number;
}>;
/** Includes returned native bytes, decoded vectors and logical retention, not RSS or SQLite CPU. */
export const SourceIndexQueryResourcesSchema = SourceSemanticAcquisitionSchema.unwrap().shape.resources;
export type SourceIndexQueryResources = SourceSemanticAcquisition["resources"];
export type SourceIndexQueryCompletion = SourceSemanticAcquisition["completion"];
export type SourceIndexVectorQueryState = NonNullable<SourceSemanticAcquisition["vector"]["state"]>;
export type SourceIndexVectorBinding = Extract<SourceIndexVectorQueryState, { binding: unknown }>["binding"];
export type SourceIndexVectorCursor = Readonly<{
  binding: SourceIndexVectorBinding; after_window_id: string;
}>;
export type SourceIndexLexicalRank = SourceIndexRootNomination["lexical"][number];
export type SourceIndexLexicalCandidate = Readonly<{
  source: SourceIndexTarget; lexical: SourceIndexLexicalRank;
}>;
export type SourceIndexQueryWindow = NonNullable<SourceIndexRootNomination["vector"]>["window"];
export type SourceIndexVectorCandidate = Readonly<{
  source: SourceIndexTarget; window: SourceIndexQueryWindow; embedding: Float32Array;
}>;
type SourceIndexQueryResourceRefusal = SourceSemanticAcquisition["resource_refusals"][number];
/** Separate from the navigation-text digest: binds the actual terms and captured segmenter state. */
type SourceIndexLexicalTokenization = NonNullable<SourceSemanticAcquisition["lexical"]["tokenization"]>;
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

/** Field callers delegate to authorizeSourceIndexScope after native root-kind binding;
 * record-only semantic consumers retain authorizeSemanticScope. Denied roots are skipped, not native unknowns.
 * There is deliberately no unrestricted default. The callback must not perform unmetered native reads.
 */
export type SourceIndexScopeAdmission = (scopeClass: string | null, source: SourceIndexTarget) => "admitted" | "denied";

export type SourceIndexQuestionTimeDomain = Readonly<{ resources: SourceIndexQueryResources }> & (
  Readonly<{ status: "ready"; exists: boolean; matched_root_keys: readonly string[] }> |
  Readonly<{ status: "unavailable"; reason: "question_time_read_budget" | "question_time_read_failed" }>
);

/** Complete enumerates all current H artifacts for this admitted native root, including known empty.
 * Each row binds its own current host message; context messages are never candidate evidence.
 */
export type SourceIndexTemplateRead = Readonly<{ resources: SourceIndexQueryResources }> & (
  Readonly<{ status: "complete"; statements: readonly Readonly<{
    source: SourceIndexTarget; bound: BoundSourceStatement;
  }>[] }> |
  Readonly<{ status: "unknown"; reason: string }>
);

/** A complete literal excerpt and its native source-observation clock, or an explicitly unknown read. */
export type SourceIndexTaskObservationRead = Readonly<{ resources: SourceIndexQueryResources }> & (
  Readonly<{ status: "ready"; text: string; source_observed_at: string | null }> |
  Readonly<{ status: "unknown"; reason: string }>
);

/** Statement keys of one root, aligned with the request: the host role of each key's message, per anchor
 * whether every anchor token occurs in the key text or that message, and the key text; `session_time` is
 * the root's recorded event time. The physical inventory includes unkeyed occurrences and is read even
 * for zero keys. Incomplete witness reading is unknown, never a successful empty witness set. */
export type SourceIndexStatementWitnessRead = Readonly<{ resources: SourceIndexQueryResources }> & (
  Readonly<{ status: "ready"; session_time: string | null;
    inventory: SourceIndexHostInventoryRead;
    witnesses: readonly Readonly<{ role: string | null; anchors: readonly boolean[]; statement: string }>[] }> |
  Readonly<{ status: "unknown"; reason: string }>
);

/** Complete source-owned physical inventory. Captured-empty is authoritative; other states are not absence. */
type SourceIndexHostInventoryRead = Readonly<
  | { status: "captured"; inventory: HostOccurrenceInventory }
  | { status: "unknown" | "unavailable" | "invalid" | "resource_limited" }
>;

/** Mechanical reads behind Core acquisition; no caller-selected generation or ANN authority. */
export interface SourceIndexQueryRepository {
  /** Null occurrence reads metadata only. Authorization precedes inventory/payload access. */
  readHostDependency?(workspaceId: string, reference: SourceIndexHostDependencyReference, occurrenceId: string | null,
    budget: SourceSemanticResourceBudget, admit: SourceIndexScopeAdmission,
    window?: Readonly<{ start_offset?: number; byte_limit: number; metadata_only?: boolean }>): SourceIndexHostDependencyRead;
  readLexicalCandidates(workspaceId: string, navigationText: string, limit: number,
    budget: SourceSemanticResourceBudget, questionTime?: QuestionTimePreference): SourceIndexLexicalRead;
  readQuestionTimeDomain?(workspaceId: string, preference: QuestionTimePreference, rootKeys: readonly string[],
    budget: SourceSemanticResourceBudget): SourceIndexQuestionTimeDomain;
  readTemplateStatements?(source: SourceIndexTarget, budget: SourceSemanticResourceBudget): SourceIndexTemplateRead;
  readTaskObservation?(source: SourceIndexTarget, span: Readonly<{ start_byte: number; end_byte: number }>,
    budget: SourceSemanticResourceBudget): SourceIndexTaskObservationRead;
  readStatementWitnesses?(source: SourceIndexTarget, keys: readonly SourceIndexTarget[], anchors: readonly string[],
    budget: SourceSemanticResourceBudget): SourceIndexStatementWitnessRead;
  readVectorCandidates(workspaceId: string, cursor: SourceIndexVectorCursor | null, limit: number,
    budget: SourceSemanticResourceBudget): SourceIndexVectorRead;
  /** A vector binding is only a comparison against the actual selected active pointer, never a read selector. */
  admitQueryCandidate(source: SourceIndexTarget, vectorBinding: SourceIndexVectorBinding | null,
    budget: SourceSemanticResourceBudget): SourceIndexQueryAdmission;
}
export type SourceIndexRootNomination = SourceSemanticAcquisition["nominations"][number];
export type SourceIndexNominationAccounting = SourceSemanticAcquisition["accounting"];
export type SourceIndexAcquisitionInput = Readonly<{
  workspace_id: string; navigation_text: string; vector: SourceIndexQueryVector;
  allowance: SourceIndexNominationAllowance; budget: SourceSemanticResourceBudget;
  question_time?: QuestionTimePreference;
  source_template?: SourceTemplateProposal;
  /** Untrusted optional proposal; acquisition admits it after protecting the incumbent. */
  source_task_observation?: unknown;
}>;
/** Bounded schedule completion, never a source-absence certificate. Leaf-safe semantic authority only. */
export type SourceIndexAcquisitionResult = SourceSemanticAcquisition;
