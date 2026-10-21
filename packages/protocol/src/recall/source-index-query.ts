import type { SourceSemanticResourceBudget } from "../garden/source-semantic-resources.js";
import type { SourceIndexProfile, SourceIndexTarget } from "./source-index.js";
import { SourceSemanticAcquisitionSchema, type SourceSemanticAcquisition } from "../garden/source-semantic-phase-semantics.js";

/** Private acquisition input, not an MCP vector input or an inference-usage receipt. */
export type SourceIndexQueryVector = Readonly<{
  status: "available"; profile: SourceIndexProfile; profile_id: string;
  input_digest: string; embedding: Float32Array;
}> | Readonly<{ status: "unavailable"; reason: string }>;

/** One total allowance. There are no implicit per-channel quotas or refill allowances. */
export type SourceIndexNominationAllowance = Readonly<{
  max_attempts: number; max_roots: number; max_vector_windows: number;
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
export type SourceIndexRootNomination = SourceSemanticAcquisition["nominations"][number];
export type SourceIndexNominationAccounting = SourceSemanticAcquisition["accounting"];
export type SourceIndexAcquisitionInput = Readonly<{
  workspace_id: string; navigation_text: string; vector: SourceIndexQueryVector;
  allowance: SourceIndexNominationAllowance; budget: SourceSemanticResourceBudget;
}>;
/** Bounded schedule completion, never a source-absence certificate. Leaf-safe semantic authority only. */
export type SourceIndexAcquisitionResult = SourceSemanticAcquisition;
