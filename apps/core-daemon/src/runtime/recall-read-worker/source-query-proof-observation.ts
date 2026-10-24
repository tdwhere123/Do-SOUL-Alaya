import {
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SourceSemanticLibraryUnprovedComputationSchema,
  SourceSemanticResourceExhausted, canonicalJson, sourceGoldRootIdentity,
  type SourceEvidenceTarget, type SourceSemanticCorrespondence, type SourceSemanticLibraryProof,
  type SourceSemanticLibraryUnprovedComputation, type SourceSemanticQuery,
  type SourceSemanticReadableWorkerRequest
} from "@do-soul/alaya-protocol";
import {
  CoreError, admitSourceSemanticCorrespondence, executeSourceSemanticInterpretation,
  proofEntriesFromBranch, scopeSourceSemanticLibraryBranch, sourceSemanticSupportExtent
} from "@do-soul/alaya-core";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import { admissionOf, loadVerified, type SourceSemanticWorkerPayload,
  type VerifiedInterpretation } from "./source-semantic-discovery.js";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";

/** The Q/H/C branch text an admitted proof actually needs visible before the
 * library surface may qualify a delivered source slot as conditional support.
 * `complete` distinguishes a located interval from a root with no interval. */
export type SourceQueryProofSupport = Readonly<{
  proof: SourceSemanticLibraryProof;
  root: string;
  start_byte: number;
  end_byte: number;
  complete: boolean;
}>;

export type SourceQueryProofObservation = Readonly<{
  proofs: readonly SourceSemanticLibraryProof[];
  unproved: readonly SourceSemanticLibraryUnprovedComputation[];
  examined: readonly string[];
  /** Roots a Q/H/C package actually grounded, in examination order. */
  admitted_roots: readonly SourceEvidenceTarget[];
  /** Proof entries collapsed onto one root occupancy; never a delivered count. */
  duplicate_bindings: number;
  support: readonly SourceQueryProofSupport[];
  pairs: number;
  executed_count: number;
  compute_open: boolean;
  interpretation_truncated: boolean;
}>;

const EMPTY: SourceQueryProofObservation = { proofs: [], unproved: [], examined: [], admitted_roots: [],
  duplicate_bindings: 0, support: [], pairs: 0, executed_count: 0, compute_open: false,
  interpretation_truncated: false };

/** Observation for the library surface over the field's own source membership.
 * Admission, currentness and proof computation stay at their existing owners;
 * this produces Q/H/C evidence, never a second selection or recall order.
 */
export function observeSourceQueryProofs(runtime: SourceSemanticReadRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  request: Extract<SourceSemanticReadableWorkerRequest, { kind: "recall" }>,
  query: SourceSemanticQuery | undefined, original: string, fieldClock: string,
  candidates?: readonly string[]): SourceQueryProofObservation {
  if (query === undefined) return EMPTY;
  const correspondences = correspondencesByInterpretation(request.semantic_correspondences ?? []);
  const proofs: SourceSemanticLibraryProof[] = [], unproved: SourceSemanticLibraryUnprovedComputation[] = [];
  const examined: string[] = [], support: SourceQueryProofSupport[] = [], admitted = new Map<string, SourceEvidenceTarget>();
  let pairs = 0, executedCount = 0, computeOpen = false, interpretationTruncated = false, entries = 0;
  for (const [interpretation_id, prepared] of correspondences) {
    // A prepared query handle owns the interpretations this request may examine; the
    // handle's source restriction is part of that candidate set, not a post-filter.
    if (candidates !== undefined && !candidates.includes(interpretation_id)) continue;
    for (const semantic_correspondence of prepared) {
      if (pairs >= SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP) break;
      pairs += 1;
      try {
        const checked = loadVerified(runtime, payload.workspace_id, interpretation_id, authorized, meter);
        // Examined means the interpretation body was actually read for this request.
        if (!examined.includes(interpretation_id)) examined.push(interpretation_id);
        const remaining = { ...request.budget, ...meter.remaining() };
        if (remaining.work_units < remaining.finalization_reserve + remaining.min_envelope) {
          computeOpen = true; interpretationTruncated = true; break;
        }
        const aligned = admitSourceSemanticCorrespondence({ semantic_correspondence,
          source_interpretation: checked.bound.interpretation, query_semantics: query, original_query: original });
        if (aligned.kind !== "admitted") { computeOpen = true; continue; }
        const executed = executeSourceSemanticInterpretation({ computation: {
          contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
          source_interpretation_id: aligned.interpretation_id, query_semantics_id: aligned.query_id,
          semantic_correspondence_id: aligned.semantic_correspondence_id, original_query: original, budget: remaining
        }, source_interpretation: checked.bound, query_semantics: query, semantic_correspondence,
        original_query: original, workspaceId: payload.workspace_id, scope: checked.stored.record.scope_class!,
        authorizedScopes: authorized, asOf: fieldClock, sourceValidity: checked.stored.record,
        source_target: checked.bound.source_target });
        executedCount += 1;
        if (executed.result.resource_usage !== undefined) {
          meter.charge(executed.result.resource_usage.work_units, executed.result.resource_usage.memory_bytes,
            "library branch");
        }
        if (executed.result.outcome.status === "resource_exhausted"
          || executed.result.completeness?.logical_index !== "complete") computeOpen = true;
        if ((executed.result.binding_results ?? []).length === 0) {
          const control = unprovedControl(checked.stored.record, aligned, executed.result, meter);
          if (control !== undefined) unproved.push(control);
          continue;
        }
        if (executed.index === null) { computeOpen = true; continue; }
        const scoped = scopeSourceSemanticLibraryBranch(executed.index, executed.result);
        const group = proofEntriesFromBranch(scoped.index, scoped.result);
        if (group.entries.length === 0) continue;
        const proof = { ...scoped.result, original_query: original, source_record: checked.stored.record,
          interpretation: aligned.interpretation, query: aligned.query,
          semantic_correspondence: aligned.semantic_correspondence, context: aligned.context };
        meter.retain([group, proof], "library branch retention");
        proofs.push(proof);
        entries += group.entries.length;
        const root = proof.source_target === undefined ? undefined : sourceGoldRootIdentity(proof.source_target);
        if (proof.source_target !== undefined && root !== undefined) {
          admitted.set(root, proof.source_target);
          // The executed proof's own dependency closure locates required support. Reasoning
          // entry spans are derived outputs and need not contain that text at all.
          const located = proofSupport(proof, executed.source_dependencies ?? [], meter,
            Buffer.byteLength(checked.stored.content_bytes, "utf8"));
          if (located === undefined) { computeOpen = true; continue; }
          support.push({ proof, root, ...located });
        }
      } catch (error) {
        if (error instanceof SourceSemanticResourceExhausted) { computeOpen = true; break; }
        if (error instanceof CoreError && (admissionOf(error) === "filtered"
          || admissionOf(error) === "no_eligible_source" || error.code === "NOT_FOUND")) continue;
        // A withdrawn or budget-limited premise yields no proof for this page, but raw
        // source delivery and the residual stay honest. Ambiguous or malformed reads fail.
        const unavailable = error instanceof CoreError ? error.details?.unavailable : undefined;
        if (error instanceof CoreError && admissionOf(error) === "unavailable"
          && (unavailable === "absent" || unavailable === "resource_limited")) {
          computeOpen = true;
          continue;
        }
        throw error;
      }
    }
    if (pairs >= SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP) break;
  }
  return { proofs, unproved, examined, admitted_roots: [...admitted.values()],
    duplicate_bindings: Math.max(0, entries - admitted.size), support,
    pairs, executed_count: executedCount, compute_open: computeOpen, interpretation_truncated: interpretationTruncated };
}

/** A completed computation without bindings is control evidence, never a proof or source fact. */
function unprovedControl(record: NonNullable<VerifiedInterpretation["stored"]["record"]>,
  aligned: Readonly<{ interpretation_id: string; query_id: string; semantic_correspondence_id: string }>,
  result: NonNullable<Awaited<ReturnType<typeof executeSourceSemanticInterpretation>>["result"]>,
  meter: SourceSemanticReadBudget): SourceSemanticLibraryUnprovedComputation | undefined {
  if (result.outcome.status !== "interpreted" || result.completeness?.logical_index !== "complete") return undefined;
  meter.charge(1, 0, "library unproved computation projection");
  const control = SourceSemanticLibraryUnprovedComputationSchema.parse({ kind: "complete_zero_binding",
    conclusion_scope: result.conclusion_scope, world_claim: result.world_claim,
    source_record: { workspace_id: record.workspace_id, source_id: record.source_id,
      identity: record.identity, source_version: record.source_version,
      content_digest: record.content_digest,
      ...(record.source_representation === undefined ? {}
        : { source_representation: record.source_representation }) },
    source_interpretation_id: aligned.interpretation_id, query_semantics_id: aligned.query_id,
    semantic_correspondence_id: aligned.semantic_correspondence_id,
    conditional_computation_id: result.conditional_computation_id,
    completeness: result.completeness, attention: result.attention });
  meter.retain(control, "library unproved computation");
  return control;
}

/** Authoritative visible support for one executed proof. The shared support-window
 * owner maps the proof's dependency closure onto the interpretation's own source
 * locations; this surface never derives support from delivered reasoning entries.
 * `complete: false` is the shared owner's no-location fallback: only the whole body
 * may then qualify, never an arbitrary window.
 */
function proofSupport(proof: SourceSemanticLibraryProof, dependencies: readonly string[],
  meter: SourceSemanticReadBudget, bodyBytes: number): Readonly<{ start_byte: number; end_byte: number;
    complete: boolean }> | undefined {
  const extent = sourceSemanticSupportExtent(proof.interpretation, dependencies, meter);
  if (extent.status === "unavailable") {
    // No dependency closure or budget refusal cannot be represented as source support.
    // `location_missing` is the shared whole-source fallback: only the actual body extent
    // may qualify, never a producer Boolean over a one-byte prefix.
    return extent.reason === "location_missing" ? { start_byte: 0, end_byte: bodyBytes, complete: false } : undefined;
  }
  return { start_byte: extent.start, end_byte: extent.end, complete: true };
}

/** Root-anchored because a delivered slot may carry independent Q/H/C premises. */
export function proofSupportFor(support: readonly SourceQueryProofSupport[],
  root: string): readonly SourceQueryProofSupport[] {
  return support.filter(row => row.root === root);
}

function correspondencesByInterpretation(rows: readonly SourceSemanticCorrespondence[]) {
  const mapped = new Map<string, SourceSemanticCorrespondence[]>(), seen = new Set<string>();
  for (const row of rows) {
    const identity = canonicalJson(row);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const list = mapped.get(row.source_interpretation_id) ?? [];
    list.push(row);
    mapped.set(row.source_interpretation_id, list);
  }
  return mapped;
}
