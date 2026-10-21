import { sourceGoldRootIdentity } from "../../recall/conditional-field/product-identity.js";
import { type SourceSemanticProfiledAcquisitionPhase, type SourceSemanticAccessProfile } from "../../garden/source-semantic-access-profile.js";
import { packSourceSemanticAcquisition, packSourceSemanticQueryPreparation } from "../../garden/source-semantic-phase-codec.js";
import { unavailableSourceQueryPreparation } from "../../garden/source-semantic-phase-semantics.js";
import type { SourceSemanticProfiledAccessReceipt } from "../../garden/source-semantic-access.js";

export const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
export const allowance = { max_attempts: 32, max_roots: 24, max_vector_windows: 4096 };
export const profile: SourceSemanticAccessProfile = {
  contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7", protocol_version: 9,
  order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
  channels: "dual", declared_allowance: allowance
};
export function acquired(): SourceSemanticProfiledAcquisitionPhase {
  const occurrences = Array.from({ length: 16 }, (_, index) => {
    const target = { kind: "source_evidence" as const, workspace_id: "workspace", root_kind: "source_record" as const,
      root_id: digest(index + 1), source_version: "v1", content_digest: digest(100), evidence_object_id: null };
    return { reference: `native-${index}`, attempt: index + 1,
      source: { source_id: `source-${index}`, root_key: sourceGoldRootIdentity(target), target, body_bytes: 32 },
      view: "original" as const, route: { kind: "lexical" as const, native_rank: index + 1, lane: "unicode61" as const,
        lane_rank: index + 1, bm25: -1, hit: { status: "unavailable" as const, reason: "native_lexical_ranges_unavailable" } } };
  });
  return { policy: profile.acquisition_policy, channels: "dual", declared_allowance: allowance, allowance,
    status: "executed", reason: null, budget: { work_units: 20_000, memory_bytes: 1_000_000 }, accounting: "complete",
    result: { navigation_digest: digest(100), completion: "partial", occurrence_prefix: occurrences,
      prefix_coverage: { kind: "retained_occurrence_prefix", omitted_occurrences: 1 },
      counts: { attempts: 19, retained_occurrences: 17, distinct_roots: 16, duplicate_occurrences: 1,
        denied: 1, unknown: 0, nomination_limit: 0, resource_refused_before_start: 0, resource_refused_after_start: 1 },
      lanes: [
        { view: "original", route: "lexical", availability: { status: "captured", captured_occurrences: 22 },
          consumed_occurrences: 19, remaining_captured_occurrences: 3, last_native_rank: 19 },
        { view: "original", route: "vector", availability: { status: "measured_empty" },
          consumed_occurrences: 0, remaining_captured_occurrences: 0, last_native_rank: null },
        { view: "hint", route: "lexical", availability: { status: "absent" },
          consumed_occurrences: 0, remaining_captured_occurrences: 0, last_native_rank: null },
        { view: "hint", route: "vector", availability: { status: "unavailable", reason: "hint_not_prepared" },
          consumed_occurrences: 0, remaining_captured_occurrences: 0, last_native_rank: null }
      ],
      resources: { work: 71, memory_bytes: 103, native_bytes: 211, sql_internal_work: "unknown" },
      resource_refusals: [{ stage: "admission", phase: "source_guard" }],
      lexical: { completion: "partial", index_coverage: "partial", reason: null, limitations: [], tokenization: null },
      vector: { completion: "complete", state: null, reason: null, inspected_windows: 0, invalid_windows: 0,
        validation: "not_run", ranking: "exact_over_inspected_subset", input: { status: "unavailable", reason: "no_vector_input" } },
      limitations: ["nominations_are_not_source_absence"] }
  };
}
export function access(): SourceSemanticProfiledAccessReceipt {
  return { contract: "source-semantic-access-v3", profile, input_id: digest(201), pool_id: digest(202),
    phases: [2, packSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("none")), packSourceSemanticAcquisition(acquired()), null],
    observed_source_count: 0, observed_interpretation_count: 0, source_candidates: [], interpretation_candidates: [],
    trace: { kind: "library_selection", omitted_source_count: 0, omitted_interpretation_count: 0 },
    unvisited_sources: true, unvisited_interpretations: true, stopping_reasons: [] };
}
