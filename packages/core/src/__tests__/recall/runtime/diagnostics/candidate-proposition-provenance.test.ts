import { describe, expect, it } from "vitest";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
} from "@do-soul/alaya-protocol";
import { CANDIDATE_PROPOSITION_PROVENANCE_OPERATOR_ID } from
  "../../../../recall/runtime/diagnostics/candidate-proposition-provenance.js";
import {
  DISTRACTOR,
  FORBIDDEN_RANKING_KEYS,
  GOLD,
  candidate,
  collate,
  collectKeys,
  frame,
  gapInput
} from "./candidate-proposition-provenance-fixture.js";

describe("candidate proposition provenance collator", () => {
  it("records unavailable OSF/composition per candidate instead of known-zero", () => {
    const map = collate(gapInput());
    expect(Object.keys(map).sort()).toEqual([DISTRACTOR, GOLD]);
    for (const row of Object.values(map)) {
      expect(row.osf.status).toBe("unavailable");
      expect(row.osf.reason).toBe("certified_osf_receipt_absent");
      expect(row.osf.completeness_present).toBe(false);
      expect(row.osf.composition_status).toBe("unavailable");
      expect(row.osf.bindings).toEqual({
        status: "unavailable",
        reason: "certified_osf_receipt_absent"
      });
      expect(row.osf.bindings).not.toEqual({ status: "available", value: [] });
      expect(JSON.stringify(row)).not.toContain("known_zero");
      expect(row.supersession).toEqual({
        status: "unavailable",
        reason: "supersession_receipt_absent"
      });
      expect(row.contradiction).toEqual({
        status: "unavailable",
        reason: "contradiction_receipt_absent"
      });
      expect(row.polarity).toEqual({
        status: "unavailable",
        reason: "polarity_receipt_absent"
      });
      expect(row.relation_validity).toEqual({
        status: "unavailable",
        reason: "relation_validity_receipt_absent"
      });
    }
  });

  it("keeps composition no_match as unavailable bindings, not an empty known set", () => {
    const map = collate({
      ...gapInput(),
      open_semantic_factor_composition: {
        status: "no_match",
        truncated: false,
        bindings: []
      }
    });
    const row = map[GOLD]!;
    expect(row.osf.composition_status).toBe("no_match");
    expect(row.osf.bindings.status).toBe("unavailable");
    expect(row.osf.bindings).not.toMatchObject({ status: "available", value: [] });
  });

  it("does not let a rule-based or model fallback frame impersonate certified OSF", () => {
    const map = collate({
      candidate_keys: [GOLD],
      query_osf_formation: {
        status: "formed",
        producer_operator_id: RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID
      },
      candidates: [candidate(GOLD, {
        typed_fact_frames: [frame(RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID, [
          ["subject", "Alice"],
          ["relation", "lives"],
          ["value", "Paris"]
        ])]
      })]
    });
    const row = map[GOLD]!;
    expect(row.osf.status).toBe("unavailable");
    expect(row.osf.reason).toBe("certified_osf_receipt_absent");
    expect(row.osf.producer_operator_id).toBe(RULE_BASED_QUERY_FACT_FRAME_OPERATOR_ID);
    expect(row.typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_query_producer_denied"
    });
    expect(JSON.stringify(row.typed_fact_frames)).not.toContain("Alice");

    const fallback = collate({
      candidate_keys: [GOLD],
      query_osf_formation: {
        status: "formed",
        producer_operator_id: "model_fallback_osf_v1"
      },
      candidates: [candidate(GOLD)]
    });
    expect(fallback[GOLD]?.osf.status).toBe("unavailable");
    expect(fallback[GOLD]?.osf.reason).toBe("certified_osf_receipt_absent");
    expect(fallback[GOLD]?.osf.producer_operator_id).toBe("model_fallback_osf_v1");
  });

  it("copies certified OSF bindings only when evidence already links the candidate", () => {
    const binding = {
      variable_id: "v-city",
      binding_identity: "osf-binding:alice-lives-paris",
      semantic_identity: "city:paris",
      evidence_id: "ev-gold",
      query_proposition_id: "q-alice-lives",
      evidence_proposition_id: "e-alice-lives"
    };
    const map = collate({
      candidate_keys: [GOLD, DISTRACTOR],
      query_osf_formation: {
        status: "formed",
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
      },
      query_osf_completeness: {
        query_producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
      },
      open_semantic_factor_composition: {
        status: "composed",
        truncated: false,
        bindings: [binding]
      },
      candidates: [
        candidate(GOLD, { evidence_ids: ["ev-gold"] }),
        candidate(DISTRACTOR, { evidence_ids: ["ev-other"] })
      ]
    });
    expect(map[GOLD]?.osf.status).toBe("certified");
    expect(map[GOLD]?.osf.reason).toBeNull();
    expect(map[GOLD]?.osf.bindings).toEqual({
      status: "available",
      value: [binding]
    });
    expect(map[DISTRACTOR]?.osf.status).toBe("unavailable");
    expect(map[DISTRACTOR]?.osf.reason).toBe("osf_binding_not_attributed");
    expect(map[DISTRACTOR]?.osf.formation_status).toBe("formed");
    expect(map[DISTRACTOR]?.osf.completeness_present).toBe(true);
    expect(map[DISTRACTOR]?.osf.composition_status).toBe("composed");
    expect(map[DISTRACTOR]?.osf.producer_operator_id).toBe(
      QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
    );
    expect(map[DISTRACTOR]?.osf.bindings).toEqual({
      status: "unavailable",
      reason: "osf_binding_not_attributed"
    });
  });

  it("keeps truncated composed OSF bindings unavailable", () => {
    const binding = {
      variable_id: "v-city",
      binding_identity: "osf-binding:alice-lives-paris",
      semantic_identity: "city:paris",
      evidence_id: "ev-gold",
      query_proposition_id: "q-alice-lives",
      evidence_proposition_id: "e-alice-lives"
    };
    const map = collate({
      candidate_keys: [GOLD],
      query_osf_formation: {
        status: "formed",
        producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
      },
      query_osf_completeness: {
        query_producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID
      },
      open_semantic_factor_composition: {
        status: "composed",
        truncated: true,
        bindings: [binding]
      },
      candidates: [candidate(GOLD, { evidence_ids: ["ev-gold"] })]
    });
    const row = map[GOLD]!;
    expect(row.osf.status).toBe("unavailable");
    expect(row.osf.reason).toBe("osf_composition_truncated");
    expect(row.osf.formation_status).toBe("formed");
    expect(row.osf.completeness_present).toBe(true);
    expect(row.osf.composition_status).toBe("composed");
    expect(row.osf.bindings).toEqual({
      status: "unavailable",
      reason: "osf_composition_truncated"
    });
  });

  it("rejects duplicate candidate keys", () => {
    expect(() => collate({
      candidate_keys: [GOLD, GOLD],
      candidates: [candidate(GOLD)]
    })).toThrow(/duplicate candidate provenance key: cand-gold/);
    expect(() => collate({
      candidate_keys: [GOLD],
      candidates: [
        candidate(GOLD, { evidence_ids: ["ev-1"] }),
        candidate(GOLD, { evidence_ids: ["ev-2"] })
      ]
    })).toThrow(/duplicate candidate provenance key: cand-gold/);
  });

  it("emits an empty map only when the candidate field is empty", () => {
    expect(collate({
      candidate_keys: [],
      candidates: [candidate(GOLD)]
    })).toEqual({});
    expect(Object.keys(collate(gapInput())).sort()).toEqual([DISTRACTOR, GOLD]);
  });

  it("does not emit fused_score, quality, or reserve fields", () => {
    const planted = Object.assign(candidate(GOLD), {
      fused_score: 0.9,
      quality: 1,
      reserve: "synthesis"
    });
    const map = collate({
      ...gapInput(),
      candidates: [planted]
    });
    const keys = collectKeys(map);
    for (const forbidden of FORBIDDEN_RANKING_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(map[GOLD]?.operator_id).toBe(CANDIDATE_PROPOSITION_PROVENANCE_OPERATOR_ID);
    expect(JSON.parse(JSON.stringify(map))[GOLD]?.candidate_key).toBe(GOLD);
  });
});
