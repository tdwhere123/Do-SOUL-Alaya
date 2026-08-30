import {
  parsePointwiseObservation,
  type EmbDomain,
  type LexDomain,
  type ShadowSubjectComponent
} from "../../../../recall/decision/query-proof/observations.js";
import { parseShadowEnvelope } from "../../../../recall/decision/prefix-capture/envelope.js";
import type {
  ShadowPsiCandidateView,
  ShadowPsiHGate,
  ShadowPsiLineages,
  ShadowPsiObservationField
} from "../../../../recall/decision/query-proof/psi.js";

export const PORTER_3: LexDomain = {
  lane_id: "porter",
  list_n: 3,
  status: "complete",
  raw_key_kind: "bm25_raw_rank"
};

export const PORTER_4: LexDomain = {
  lane_id: "porter",
  list_n: 4,
  status: "complete",
  raw_key_kind: "bm25_raw_rank"
};

export const PORTER_TRUNCATED: LexDomain = {
  lane_id: "porter",
  list_n: 100,
  status: "truncated",
  raw_key_kind: "bm25_raw_rank"
};

export const PORTER_COMPLETE_10: LexDomain = {
  lane_id: "porter",
  list_n: 10,
  status: "complete",
  raw_key_kind: "bm25_raw_rank"
};

export const EXACT_2: LexDomain = {
  lane_id: "exact",
  list_n: 2,
  status: "complete",
  raw_key_kind: "matched_token_count"
};

export const EMB: EmbDomain = {
  provider_kind: "local",
  model_id: "nomic",
  dimensions: 8,
  schema_version: 1
};

export const EMB_OTHER: EmbDomain = {
  ...EMB,
  model_id: "other"
};

export const WINDOW = {
  kind: "window" as const,
  query_id: "q",
  start_ms: 1,
  end_ms: 2,
  decay_days: 90 as const
};

export function view(
  lineages: ShadowPsiLineages,
  h_gate: ShadowPsiHGate = "none"
): ShadowPsiCandidateView {
  return { h_gate, lineages };
}

export function field(
  entries: Record<string, ShadowPsiCandidateView>
): ShadowPsiObservationField {
  return entries;
}

export function lexicalObs(envelope: unknown, domain: LexDomain | null) {
  return parsePointwiseObservation({
    lineage: "lexical",
    receipt: "fts.lexical.observe.v1",
    correlation: "dup:lexical-family",
    envelope,
    domain
  });
}

export function embeddingObs(
  envelope: unknown,
  snapshot: Readonly<{
    readonly status: string;
    readonly value: number | null;
    readonly domain: EmbDomain | null;
    readonly content_hash: string | null;
  }>
) {
  return parsePointwiseObservation({
    lineage: "embedding",
    receipt: "embed.observe.v1",
    correlation: "dup:embed-max-v1",
    envelope,
    snapshot
  });
}

export function temporalObs(envelope: unknown, value: number | null = null) {
  const observed = envelope !== null &&
    typeof envelope === "object" &&
    "state" in envelope &&
    envelope.state === "observed";
  return parsePointwiseObservation({
    lineage: "temporal",
    receipt: "temporal.observe.v1",
    correlation: "temporal.observe.v1",
    envelope,
    evaluator: {
      applicable: true,
      parse_state: "window",
      clock_state: "ok",
      candidate_evaluated: observed,
      event_time: observed ? "2020-01-01T00:00:00Z" : null,
      domain: observed ? WINDOW : null,
      finite_value: observed ? value : null
    }
  });
}

export function temporalObserved(value: number) {
  return temporalObs({ state: "observed", value }, value);
}

export function embeddingObserved(value: number, domain: EmbDomain = EMB) {
  return embeddingObs({ state: "observed", value }, {
    status: "observed",
    value,
    domain,
    content_hash: "hash-a"
  });
}

export function embeddingMissing() {
  return embeddingObs({ state: "not_observed", reason: "missing_vector" }, {
    status: "not_observed",
    value: null,
    domain: EMB,
    content_hash: null
  });
}

export function lexicalAt(
  state: "observed" | "not_applicable" | "producer_unavailable" | "not_observed",
  value = 0.8,
  domain: LexDomain | null = PORTER_3
) {
  if (state === "observed") return lexicalObs({ state, value }, domain);
  if (state === "not_observed") {
    return lexicalObs({ state, reason: "missing_rank" }, null);
  }
  return lexicalObs({ state }, null);
}

export function subjectComponent(
  componentId: ShadowSubjectComponent["component_id"],
  envelope: unknown
): ShadowSubjectComponent {
  const parsedEnvelope = parseShadowEnvelope(envelope);
  return {
    component_id: componentId,
    operator_id: componentId === "preference"
      ? "scorePreferenceProfileAlignment"
      : "scoreSubjectAlignment",
    authority_state: parsedEnvelope.state === "observed" ||
      parsedEnvelope.state === "observed_negative"
      ? "evaluated"
      : parsedEnvelope.state === "not_applicable"
        ? "not_applicable"
        : parsedEnvelope.state === "producer_unavailable" ? "untrusted" : "not_run",
    envelope: parsedEnvelope
  };
}

export function transitivityField() {
  return field({
    A: view({
      temporal: temporalObserved(0.9),
      embedding: embeddingObserved(0.8)
    }),
    B: view({
      temporal: temporalObserved(0.6),
      embedding: embeddingObserved(0.7)
    }),
    C: view({
      temporal: temporalObserved(0.3),
      embedding: embeddingObserved(0.2)
    })
  });
}

export function subjectObs(
  envelope: unknown,
  components: readonly ShadowSubjectComponent[]
) {
  const applicable = components.filter((component) =>
    component.envelope.state !== "not_applicable");
  return parsePointwiseObservation({
    lineage: "subject_preference",
    receipt: "subject.observe.v1",
    correlation: "subject.observe.v1",
    envelope,
    domain: {
      query_id: "q",
      applicable_component_ids: applicable.map((component) => component.component_id),
      component_operator_ids: applicable.map((component) => component.operator_id)
    },
    components
  });
}
