import { describe, expect, it } from "vitest";
import {
  combineSubjectComponentEnvelopes,
  embeddingDomainsEqual,
  parsePointwiseObservation,
  type EmbDomain,
  type LexDomain,
  type ShadowSubjectComponent,
  type ShadowTemporalEvaluator
} from "../../../../recall/decision/query-proof/observations.js";
import { ShadowContractError } from "../../../../recall/decision/query-proof/envelope.js";

const PORTER: LexDomain = {
  lane_id: "porter",
  list_n: 3,
  status: "complete",
  raw_key_kind: "bm25_raw_rank"
};

const EMB_A: EmbDomain = {
  provider_kind: "local",
  model_id: "nomic",
  dimensions: 8,
  schema_version: 1
};

const EMB_B: EmbDomain = {
  ...EMB_A,
  model_id: "other"
};

function lexical(envelope: unknown, domain: LexDomain | null) {
  return parsePointwiseObservation({
    lineage: "lexical",
    receipt: "fts.lexical.observe.v1",
    correlation: "dup:lexical-family",
    envelope,
    domain
  });
}

function embedding(
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

function temporal(envelope: unknown, evaluator: ShadowTemporalEvaluator) {
  return parsePointwiseObservation({
    lineage: "temporal",
    receipt: "temporal.observe.v1",
    correlation: "temporal.observe.v1",
    envelope,
    evaluator
  });
}

function windowEvaluator(
  patch: Partial<ShadowTemporalEvaluator> = {}
): ShadowTemporalEvaluator {
  return {
    applicable: true,
    parse_state: "window",
    clock_state: "ok",
    candidate_evaluated: true,
    event_time: "2020-01-01T00:00:00Z",
    domain: {
      kind: "window",
      query_id: "q",
      start_ms: 1,
      end_ms: 2,
      decay_days: 90
    },
    finite_value: 0,
    ...patch
  };
}

function subject(
  envelope: unknown,
  components: readonly ShadowSubjectComponent[],
  applicable = components.filter((component) =>
    component.envelope.state !== "not_applicable")
) {
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

describe("shadow observations", () => {
  it("admits only the four pointwise lineages", () => {
    expect(lexical({ state: "observed", value: 0.8 }, PORTER).lineage).toBe("lexical");
    expect(embedding({ state: "observed", value: 0 }, {
      status: "observed",
      value: 0,
      domain: EMB_A,
      content_hash: "hash-a"
    }).lineage).toBe("embedding");
    expect(temporal({ state: "observed", value: 0 }, windowEvaluator()).lineage)
      .toBe("temporal");
    for (const lineage of ["path", "flood", "graph", "relation"]) {
      expect(() => parsePointwiseObservation({ lineage })).toThrow(
        /relational observation is not admitted/u
      );
    }
  });

  it("keeps temporal honest-zero distinct from missing event_time", () => {
    const honestZero = temporal({ state: "observed", value: 0 }, windowEvaluator());
    const missing = temporal({ state: "not_observed", reason: "missing_event_time" },
      windowEvaluator({
        candidate_evaluated: true,
        event_time: null,
        finite_value: null
      }));
    expect(honestZero.envelope).toEqual({ state: "observed", value: 0 });
    expect(missing.envelope.state).toBe("not_observed");
    expect(() => temporal({ state: "observed", value: 0 }, windowEvaluator({
      event_time: null
    }))).toThrow(/event_time/u);
    expect(() => temporal({ state: "observed", value: 0 }, windowEvaluator({
      parse_state: "unparseable_date_terms",
      domain: { kind: "recency", query_id: "q", now_iso: "now", decay_days: 365 }
    }))).toThrow(/recency/u);
  });

  it("plants embedding domain mismatch without collapsing missing to mid-scale", () => {
    expect(embeddingDomainsEqual(EMB_A, EMB_B)).toBe(false);
    expect(() => embedding({ state: "not_observed", reason: "missing_vector" }, {
      status: "not_observed",
      value: 0.5,
      domain: EMB_A,
      content_hash: null
    })).toThrow(/cannot carry a value/u);
  });

  it("routes illegal subject components before unknown, including empty applicable", () => {
    const negative: ShadowSubjectComponent = {
      component_id: "preference",
      operator_id: "scorePreferenceProfileAlignment",
      authority_state: "evaluated",
      envelope: { state: "observed_negative", named_consumer: "h_event" }
    };
    const unknown: ShadowSubjectComponent = {
      component_id: "self_reference",
      operator_id: "scoreSubjectAlignment",
      authority_state: "not_run",
      envelope: { state: "not_observed", reason: "not_run" }
    };
    expect(combineSubjectComponentEnvelopes([negative, unknown]).state)
      .toBe("observed_negative");
    expect(() => subject({ state: "not_observed" }, [negative, unknown]))
      .toThrow(/match combined/u);
    expect(subject(negative.envelope, [negative, unknown]).envelope.state)
      .toBe("observed_negative");

    const empty = subject({ state: "not_applicable" }, []);
    expect(empty.envelope.state).toBe("not_applicable");
    expect(empty.lineage).toBe("subject_preference");
    if (empty.lineage !== "subject_preference") return;
    expect(empty.domain.applicable_component_ids).toEqual([]);
  });

  it("does not hide an unknown applicable component behind an observed max", () => {
    const preference: ShadowSubjectComponent = {
      component_id: "preference",
      operator_id: "scorePreferenceProfileAlignment",
      authority_state: "not_run",
      envelope: { state: "not_observed", reason: "not_run" }
    };
    const selfRef: ShadowSubjectComponent = {
      component_id: "self_reference",
      operator_id: "scoreSubjectAlignment",
      authority_state: "evaluated",
      envelope: { state: "observed", value: 1 }
    };
    expect(combineSubjectComponentEnvelopes([preference, selfRef]).state)
      .toBe("not_observed");
    expect(() => subject({ state: "observed", value: 1 }, [preference, selfRef]))
      .toThrow(ShadowContractError);
  });

  it("keeps projection-off preference out of the applicable set when self-reference fires", () => {
    const selfRef: ShadowSubjectComponent = {
      component_id: "self_reference",
      operator_id: "scoreSubjectAlignment",
      authority_state: "evaluated",
      envelope: { state: "observed", value: 0.55 }
    };
    const off: ShadowSubjectComponent = {
      component_id: "preference",
      operator_id: "scorePreferenceProfileAlignment",
      authority_state: "not_applicable",
      envelope: { state: "not_applicable" }
    };
    const parsed = subject({ state: "observed", value: 0.55 }, [off, selfRef]);
    expect(parsed.lineage).toBe("subject_preference");
    if (parsed.lineage !== "subject_preference") return;
    expect(parsed.domain.applicable_component_ids).toEqual(["self_reference"]);
    expect(parsed.envelope).toEqual({ state: "observed", value: 0.55 });
  });
});
