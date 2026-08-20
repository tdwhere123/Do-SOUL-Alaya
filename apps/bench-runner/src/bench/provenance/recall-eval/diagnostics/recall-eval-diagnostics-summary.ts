import type { EmbeddingSupplementRuntimeProvenance } from "../../embedding/local-onnx.js";
import type { RecallEvalDiagnosticsQuestion } from "../recall-eval-diagnostics.js";

type ProviderState = RecallEvalDiagnosticsQuestion["diagnostics"]["provider_state"];
type CrossStatus = NonNullable<
  RecallEvalDiagnosticsQuestion["diagnostics"]["answer_rerank_status"]
>;

export class RecallEvalDiagnosticsSummaryAccumulator {
  readonly #document = { expected_count: 0, ready_count: 0, not_ready_count: 0 };
  readonly #query = {
    expected_count: 0, requested_count: 0, ready_count: 0, not_ready_count: 0
  };
  readonly #latency = { measured_question_count: 0, total_ms: 0, max_ms: 0 };
  readonly #providers: Record<ProviderState, number> = {
    provider_returned: 0, provider_pending: 0, provider_failed: 0,
    provider_not_requested: 0, query_embedding_unusable: 0, unknown: 0
  };
  readonly #cross: Record<CrossStatus | "unavailable", number> = {
    returned: 0, not_applicable: 0, not_requested: 0,
    failed: 0, unavailable: 0
  };
  readonly #scores = { expected_count: 0, scored_count: 0 };
  #questionCount = 0;

  add(question: RecallEvalDiagnosticsQuestion): void {
    this.#questionCount += 1;
    this.#addDocument(question);
    this.#addQuery(question);
    this.#addLatency(question.document_embedding_warmup_latency_ms);
    this.#providers[question.diagnostics.provider_state] += 1;
    this.#cross[question.diagnostics.answer_rerank_status ?? "unavailable"] += 1;
    this.#scores.expected_count +=
      question.diagnostics.answer_rerank_expected_count ?? 0;
    this.#scores.scored_count +=
      question.diagnostics.answer_rerank_scored_count ?? 0;
  }

  build(identity: EmbeddingSupplementRuntimeProvenance) {
    return {
      question_count: this.#questionCount,
      document_embedding_cache: { ...this.#document },
      query_embedding_cache: { ...this.#query },
      document_embedding_warmup_latency_ms: {
        ...this.#latency,
        mean_ms: this.#questionCount === 0 || this.#latency.measured_question_count === 0
          ? 0
          : this.#latency.total_ms / this.#latency.measured_question_count
      },
      provider_states: { total: this.#questionCount, ...this.#providers },
      answer_rerank_status_counts: { ...this.#cross },
      answer_rerank_scores: { ...this.#scores },
      embedding_identity: {
        provider_kind: identity.enabled ? identity.provider_kind : null,
        model_id: identity.enabled ? identity.effective_model_id : null,
        schema_version: identity.enabled ? identity.effective_schema_version : null,
        consistent: true as const
      }
    };
  }

  #addDocument(question: RecallEvalDiagnosticsQuestion): void {
    const row = question.document_embedding_warmup;
    if (row === null) return;
    this.#document.expected_count += row.expected_count;
    this.#document.ready_count += row.ready_count;
    this.#document.not_ready_count += row.expected_count - row.ready_count;
  }

  #addQuery(question: RecallEvalDiagnosticsQuestion): void {
    const row = question.query_embedding_warmup;
    if (row === null) return;
    this.#query.expected_count += row.requested_count;
    this.#query.requested_count += row.requested_count;
    this.#query.ready_count += row.ready_count;
    this.#query.not_ready_count += row.requested_count - row.ready_count;
  }

  #addLatency(value: number | null): void {
    if (value === null) return;
    this.#latency.measured_question_count += 1;
    this.#latency.total_ms += value;
    this.#latency.max_ms = Math.max(this.#latency.max_ms, value);
  }
}
