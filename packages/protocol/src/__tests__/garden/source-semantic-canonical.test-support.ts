import { capturePackSourceSemanticPreparationForRequest, capturePackSourceSemanticAcquisitionForRequest }
  from "../../garden/source-semantic-phase-codec.js";
import type { SourceSemanticQueryPreparation, SourceSemanticAcquisitionPhase } from "../../garden/source-semantic-phase-semantics.js";
import type { SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

/** Two real-shaped routes, with a shared source nomination, not a model/provider fixture. */
export function sourcePhaseFixture() {
  const profile = { provider_kind: "local_onnx", model_id: "simulated-fixed-axis-no-model", model_revision: "fixture-v1",
    artifact_digest: digest("a"), tokenizer_revision: "simulated-token-count-v1", dimensions: 3,
    preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 32,
    windowing: "utf8-byte-windows.v1" as const, window_bytes: 4096 };
  const selected = { selection_revision: 1, config_id: digest("b"), profile_id: digest("c"), profile };
  const preparation = (navigation: string) => ({ status: "ready" as const, reason: null, navigation_digest: navigation,
    selected, method: "local_inference" as const, submitted_inputs: 1, token_count: 2, external_api_attempts: 0,
    binding_work: "unknown" as const, execution_work: "unknown" as const, elapsed_ms: 0.5 });
  const target = { kind: "source_evidence" as const, workspace_id: "workspace-1", root_kind: "source_record" as const,
    root_id: digest("d"), source_version: "1", content_digest: digest("e"), evidence_object_id: null };
  const source = { root_key: `{"content_digest":"${digest("e")}","root_id":"${digest("d")}","root_kind":"source_record","source_version":"1","workspace_id":"workspace-1"}`,
    source_id: "raw", target, body_bytes: 27 };
  const acquisition = (supplemental: boolean) => {
    const navigation = digest(supplemental ? "2" : "1"), terms = supplemental ? ["x".repeat(1024)] : ["Why", "delayed"];
    return { policy: "source-index-interleaved-prefix.v1" as const, status: "executed" as const, reason: null,
      allowance: { max_attempts: supplemental ? 127 : 128, max_roots: supplemental ? 15 : 16,
        max_vector_windows: supplemental ? 4095 : 4096 },
      budget: { work_units: supplemental ? 97036 : 98906, memory_bytes: supplemental ? 77156 : 105312 },
      result: { policy: "source-index-interleaved-prefix.v1" as const, navigation_digest: navigation, completion: "complete" as const,
        nominations: [{ source, lexical: [], vector: { rank: 1, cosine: 1,
          window: { window_id: digest("f"), start_byte: 0, end_byte: 27, content_digest: digest("e") } } }],
        accounting: { attempted: 1, admitted: 1, duplicate: 0, rejected: 0, scope_denied: 0, native_unknown: 0,
          resource_refused: 0, stale: 0, nomination_limit: 0 },
        resources: { work: supplemental ? 5900 : 1856, memory_bytes: supplemental ? 50224 : 21968,
          native_bytes: 2036, sql_internal_work: "unknown" as const }, resource_refusals: [],
        lexical: { completion: "complete" as const, index_coverage: "partial" as const, reason: null,
          limitations: ["database_wide_bm25_statistics", "short_or_unadmitted_tokens_are_not_absence", "lexical_corpus_coverage_untracked"],
          tokenization: { policy: "source-index-fts.v1" as const, binding_digest: digest(supplemental ? "3" : "4"),
            cjk_state: "uninitialized" as const, terms, unicode61_terms: terms, trigram_terms: [] } },
        vector: { completion: "complete" as const, state: { status: "ready" as const,
          binding: { workspace_id: "workspace-1", selection_revision: 1, config_id: digest("b"), profile_id: digest("c"),
            generation_id: digest("5"), source_epoch: 1, dimensions: 3 } },
          reason: null, inspected_windows: 1, invalid_windows: 0, validation: "validated" as const,
          ranking: "exact_over_inspected_subset" as const,
          input: { status: "available" as const, profile_id: digest("c"), input_digest: navigation } },
        limitations: ["nominations_are_not_source_absence", "sqlite_internal_work_unknown",
          "native_deadline_and_interruption_require_daemon_integration", "caller_owned_read_snapshot_required", "lexical_corpus_coverage_untracked"] },
      accounting: "complete" as const };
  };
  return { preparation: { ...preparation(digest("1")), supplemental: [preparation(digest("2"))] },
    acquisition: { ...acquisition(false), supplemental: [acquisition(true)] } };
}

export function captureSourcePhaseFixture(meter: SourceSemanticResourceLedger,
  value: { preparation: unknown; acquisition: unknown } = sourcePhaseFixture()) {
  let preparation: SourceSemanticQueryPreparation | undefined, acquisition: SourceSemanticAcquisitionPhase | undefined;
  const compactPreparation = capturePackSourceSemanticPreparationForRequest(value.preparation, meter, capture => { preparation = capture; });
  const compactAcquisition = capturePackSourceSemanticAcquisitionForRequest(value.acquisition, meter, capture => { acquisition = capture; });
  return { phases: [2, compactPreparation, compactAcquisition, null] as const,
    get preparation() { return preparation!; }, get acquisition() { return acquisition!; },
    borrowPreparation: (expected: typeof compactPreparation) => expected === compactPreparation ? preparation : undefined,
    borrowAcquisition: (expected: typeof compactAcquisition) => expected === compactAcquisition ? acquisition : undefined,
    retire() { preparation = undefined; acquisition = undefined; } };
}
