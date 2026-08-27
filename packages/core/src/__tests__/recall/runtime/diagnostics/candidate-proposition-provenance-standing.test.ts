import { describe, expect, it } from "vitest";
import { CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID } from
  "../../../../recall/delivery/fine-assessment-selection/content-owned-fact-key.js";
import {
  DISTRACTOR,
  GOLD,
  candidate,
  collate,
  copiedSlots,
  frame,
  gapInput,
  hasJoinedProposition
} from "./candidate-proposition-provenance-fixture.js";

describe("candidate proposition provenance standing receipts", () => {
  it("does not turn subject inversion into an OSF witness", () => {
    const map = collate({
      ...gapInput(),
      candidates: [
        candidate(GOLD, {
          typed_fact_frames: [frame("evidence_fact_frame_v1", [
            ["subject", "Bob"],
            ["relation", "hired"],
            ["value", "Alice"]
          ])]
        }),
        candidate(DISTRACTOR)
      ]
    });
    const row = map[GOLD]!;
    expect(copiedSlots(row)).toEqual([
      { role: "subject", text: "Bob" },
      { role: "relation", text: "hired" },
      { role: "value", text: "Alice" }
    ]);
    expect(row.osf.bindings.status).toBe("unavailable");
    expect(row).not.toHaveProperty("witness");
    expect(JSON.stringify(row)).not.toContain("proposition_id");
    expect(hasJoinedProposition(row, "Alice", "hired", "Bob")).toBe(false);
  });

  it("does not false-join split multi-fact typed frames", () => {
    const map = collate({
      ...gapInput(),
      candidates: [
        candidate(GOLD, {
          typed_fact_frames: [
            frame("evidence_fact_frame_v1", [
              ["subject", "Alice"],
              ["relation", "lives"],
              ["value", "Paris"]
            ], "ev-alice"),
            frame("evidence_fact_frame_v1", [
              ["subject", "Bob"],
              ["relation", "lives"],
              ["value", "Berlin"]
            ], "ev-bob")
          ]
        }),
        candidate(DISTRACTOR)
      ]
    });
    const row = map[GOLD]!;
    expect(row.typed_fact_frames.status).toBe("available");
    if (row.typed_fact_frames.status !== "available") return;
    expect(row.typed_fact_frames.value).toHaveLength(2);
    expect(hasJoinedProposition(row, "Alice", "lives", "Berlin")).toBe(false);
    expect(row.osf.bindings.status).toBe("unavailable");
  });

  it("copies a superseded receipt without presenting it as current", () => {
    const map = collate({
      ...gapInput(),
      candidates: [
        candidate(GOLD, {
          supersession: {
            producer_operator_id: "relation_assertion_resolution_v1",
            standing: "superseded",
            superseding_assertion_id: "assert-newer"
          }
        }),
        candidate(DISTRACTOR)
      ]
    });
    const row = map[GOLD]!;
    expect(row.supersession).toEqual({
      status: "available",
      value: {
        producer_operator_id: "relation_assertion_resolution_v1",
        standing: "superseded",
        superseding_assertion_id: "assert-newer"
      }
    });
    expect(row.supersession).not.toMatchObject({ value: { standing: "current" } });
    expect(row.osf.status).toBe("unavailable");
  });

  it("does not let opposite polarity satisfy the query", () => {
    const map = collate({
      ...gapInput(),
      candidates: [
        candidate(GOLD, {
          typed_fact_frames: [frame("evidence_fact_frame_v1", [
            ["subject", "Alice"],
            ["relation", "lives"],
            ["value", "Paris"]
          ])],
          polarity: {
            producer_operator_id: "relation_assertion_polarity_v1",
            polarity: "negative"
          }
        }),
        candidate(DISTRACTOR)
      ]
    });
    const row = map[GOLD]!;
    expect(row.polarity).toEqual({
      status: "available",
      value: {
        producer_operator_id: "relation_assertion_polarity_v1",
        polarity: "negative"
      }
    });
    expect(row.osf.status).toBe("unavailable");
    expect(row.osf.bindings.status).toBe("unavailable");
    expect(JSON.stringify(row)).not.toContain("satisfies_query");
  });

  it("copies contradicted and contradicting receipts without presenting them as current cover", () => {
    const map = collate({
      candidate_keys: [GOLD, DISTRACTOR],
      candidates: [
        candidate(GOLD, {
          polarity: {
            producer_operator_id: "relation_assertion_polarity_v1",
            polarity: "negative"
          },
          contradiction: {
            producer_operator_id: "relation_assertion_resolution_v1",
            standing: "contradicted",
            counterpart_id: "assert-other"
          }
        }),
        candidate(DISTRACTOR, {
          contradiction: {
            producer_operator_id: "relation_assertion_resolution_v1",
            standing: "contradicting",
            counterpart_id: "assert-gold"
          }
        })
      ]
    });
    expect(map[GOLD]?.contradiction).toEqual({
      status: "available",
      value: {
        producer_operator_id: "relation_assertion_resolution_v1",
        standing: "contradicted",
        counterpart_id: "assert-other"
      }
    });
    expect(map[DISTRACTOR]?.contradiction).toEqual({
      status: "available",
      value: {
        producer_operator_id: "relation_assertion_resolution_v1",
        standing: "contradicting",
        counterpart_id: "assert-gold"
      }
    });
    expect(map[GOLD]?.polarity).toEqual({
      status: "available",
      value: {
        producer_operator_id: "relation_assertion_polarity_v1",
        polarity: "negative"
      }
    });
    expect(map[GOLD]?.osf.status).toBe("unavailable");
    expect(JSON.stringify(map[GOLD]?.polarity)).not.toContain("positive");
    expect(JSON.stringify(map[GOLD]?.contradiction)).not.toContain("current");
    expect(JSON.stringify(map[DISTRACTOR]?.contradiction)).not.toContain("current");
  });

  it("keeps matching tokens without certified or evidence provenance unavailable", () => {
    const planted = Object.assign(candidate(GOLD, {
      typed_fact_frames: [frame(null, [
        ["subject", "Alice"],
        ["relation", "lives"],
        ["value", "Paris"]
      ])]
    }), { content: "Alice lives in Paris" });
    const map = collate({
      candidate_keys: [GOLD],
      candidates: [planted]
    });
    const row = map[GOLD]!;
    expect(row.osf.status).toBe("unavailable");
    expect(row.typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "typed_fact_frame_producer_absent"
    });
    expect(row.evidence_links).toEqual({
      status: "unavailable",
      reason: "evidence_link_absent"
    });
    expect(JSON.stringify(row)).not.toContain("Alice lives in Paris");
  });

  it("excludes content-owned role-neutral value as proposition proof", () => {
    const map = collate({
      ...gapInput(),
      candidates: [
        candidate(GOLD, {
          typed_fact_frames: [frame(CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID, [
            ["value", "Alice lives in Paris"]
          ])],
          evidence_ids: ["ev-1"]
        }),
        candidate(DISTRACTOR)
      ]
    });
    const row = map[GOLD]!;
    expect(row.typed_fact_frames).toEqual({
      status: "unavailable",
      reason: "content_owned_excluded"
    });
    expect(row.osf.status).toBe("unavailable");
    expect(row.evidence_links).toEqual({
      status: "available",
      value: ["ev-1"]
    });
  });
});
