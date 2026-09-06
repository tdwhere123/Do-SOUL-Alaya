import { describe, expect, it } from "vitest";
import {
  COMMON_CAUSE_PROPOSITION_KIND,
  assessEvidence
} from "../../../../recall/conditional-field/evidence/assess-support.js";
import {
  assessmentInput,
  demand,
  observation,
  template
} from "./evidence.fixture.js";

describe("conditional-field evidence support", () => {
  it("A07 requires both compatible premises and keeps an alternate complete witness", () => {
    const twoPremise = demand("rel-and", "two_premise", [
      template("and", ["p1", "p2"], 400),
      template("alt", ["p3"], 200)
    ]);
    const p1 = observation({
      observation_id: "o1",
      evidence_id: "e1",
      premise_id: "p1",
      proposition_id: "rel-and"
    });
    const p2 = observation({
      observation_id: "o2",
      evidence_id: "e2",
      premise_id: "p2",
      proposition_id: "rel-and"
    });
    const p3 = observation({
      observation_id: "o3",
      evidence_id: "e3",
      premise_id: "p3",
      proposition_id: "rel-and"
    });
    expect(assessEvidence(assessmentInput({
      observations: [p1],
      propositions: [twoPremise]
    })).records[0]?.claim).toBe("unknown");
    expect(assessEvidence(assessmentInput({
      observations: [p2],
      propositions: [twoPremise]
    })).records[0]?.claim).toBe("unknown");
    const both = assessEvidence(assessmentInput({
      observations: [p1, p2],
      propositions: [twoPremise]
    }));
    expect(both.records[0]?.claim).toBe("supported");
    expect(both.explanation_ids).toContain("and/supports");
    const alternate = assessEvidence(assessmentInput({
      observations: [p3],
      propositions: [twoPremise]
    }));
    expect(alternate.records[0]?.claim).toBe("supported");
    expect(alternate.explanation_ids).toContain("alt/supports");
  });

  it("A07 rejects identical endpoints under incompatible time, binding, jurisdiction, or hypothesis", () => {
    const twoPremise = demand("rel-and", "two_premise", [template("and", ["p1", "p2"], 400)]);
    const p1 = observation({
      observation_id: "o1",
      evidence_id: "e1",
      premise_id: "p1",
      proposition_id: "rel-and"
    });
    const mismatched = [
      observation({ ...p1, observation_id: "bind", evidence_id: "e2", premise_id: "p2", binding_context: "bind-b" }),
      observation({ ...p1, observation_id: "hyp", evidence_id: "e2", premise_id: "p2", hypothesis_id: "h1" }),
      observation({ ...p1, observation_id: "time", evidence_id: "e2", premise_id: "p2", time_state: "yesterday" }),
      observation({ ...p1, observation_id: "jur", evidence_id: "e2", premise_id: "p2", jurisdiction: "other" })
    ];
    for (const p2 of mismatched) {
      const assessed = assessEvidence(assessmentInput({
        observations: [p1, p2],
        propositions: [twoPremise]
      }));
      expect(assessed.records[0]?.claim).toBe("unknown");
      expect(assessed.explanation_ids).not.toContain("and/supports");
    }
  });

  it("A08 keeps a cheaper complete witness when a canonical expensive id sorts first", () => {
    const assessed = assessEvidence(assessmentInput({
      observations: [
        observation({
          observation_id: "oa",
          evidence_id: "ea",
          premise_id: "a",
          proposition_id: "cause"
        }),
        observation({
          observation_id: "ob",
          evidence_id: "eb",
          premise_id: "b",
          proposition_id: "cause"
        })
      ],
      propositions: [demand("cause", "explanation", [
        template("canonical-expensive", ["a"], 1200),
        template("z-cheap", ["b"], 400)
      ])]
    }));
    const ids = assessed.records[0]?.witnesses.filter((witness) => witness.complete)
      .map((witness) => witness.witness_id) ?? [];
    expect(ids).toEqual(["z-cheap/supports", "canonical-expensive/supports"]);
    expect(assessed.explanation_ids).toEqual([
      "z-cheap/supports",
      "canonical-expensive/supports"
    ]);
  });

  it("A02 leaves common cause unknown while association milligrades stay non-probative", () => {
    const assessed = assessEvidence(assessmentInput({
      observations: [
        observation({
          observation_id: "hist",
          evidence_id: "eh",
          premise_id: "service_history",
          proposition_id: "common-cause",
          association_milligrades: 550,
          source_id: "s"
        })
      ],
      propositions: [demand(
        "common-cause",
        COMMON_CAUSE_PROPOSITION_KIND,
        [template("shared-root", ["shared_root_cause"], 100)],
        ["r", "h"]
      )]
    }));
    expect(assessed.records[0]?.claim).toBe("unknown");
    expect(assessed.work_status).toBe("complete");
    expect(assessed.explanation_ids).toEqual([]);
    expect(assessed.records[0]?.witnesses.some((witness) => witness.complete)).toBe(false);
  });

  it("A13 fully assessed unknown is a resolved claim, not missing work", () => {
    const assessed = assessEvidence(assessmentInput({
      observations: [],
      propositions: [demand("common-cause", COMMON_CAUSE_PROPOSITION_KIND, [
        template("shared-root", ["shared_root_cause"], 100)
      ])]
    }));
    expect(assessed.records[0]?.claim).toBe("unknown");
    expect(assessed.work_status).toBe("complete");
  });

  it("A19 duplicate hits and shared lineage do not mint independence", () => {
    const first = observation({
      observation_id: "hit-1",
      evidence_id: "e-copy",
      premise_id: "p1",
      proposition_id: "rel",
      lineage_id: "line-1"
    });
    const duplicate = observation({
      observation_id: "hit-2",
      evidence_id: "e-copy",
      premise_id: "p1",
      proposition_id: "rel",
      lineage_id: "line-1"
    });
    const copy = observation({
      observation_id: "copy",
      evidence_id: "e-line",
      premise_id: "p2",
      proposition_id: "rel",
      lineage_id: "line-1",
      independence_key: "shared-key"
    });
    const other = observation({
      observation_id: "other",
      evidence_id: "e-other",
      premise_id: "p3",
      proposition_id: "rel",
      lineage_id: "line-2",
      independence_key: "shared-key"
    });
    const assessed = assessEvidence(assessmentInput({
      observations: [first, duplicate, copy, other],
      propositions: [demand("rel", "two_premise", [template("and", ["p1", "p2"], 100)])]
    }));
    expect(assessed.correlations).toEqual(expect.arrayContaining([
      { left_id: "e-copy", right_id: "e-copy", state: "same_evidence_unit" },
      { left_id: "e-copy", right_id: "e-line", state: "same_source_lineage" },
      { left_id: "e-line", right_id: "e-other", state: "possibly_correlated" }
    ]));
    expect(assessed.correlations.every((row) => row.state !== "independent" as string)).toBe(true);
    expect(assessed.records[0]?.claim).toBe("supported");
    expect(assessed.records[0]?.witnesses.filter((witness) => witness.complete)).toHaveLength(1);
  });

  it("retains both sides of a conflict and does not pick the more associated claim", () => {
    const assessed = assessEvidence(assessmentInput({
      observations: [
        observation({
          observation_id: "yes",
          evidence_id: "e-yes",
          premise_id: "p-yes",
          proposition_id: "fact",
          polarity: "supports",
          association_milligrades: 1000
        }),
        observation({
          observation_id: "no",
          evidence_id: "e-no",
          premise_id: "p-no",
          proposition_id: "fact",
          polarity: "refutes",
          association_milligrades: 1
        })
      ],
      propositions: [demand("fact", "assertion", [
        template("yes", ["p-yes"], 100),
        template("no", ["p-no"], 100)
      ])]
    }));
    expect(assessed.records[0]?.claim).toBe("conflict");
    expect(assessed.polarities["yes/supports"]).toBe("supports");
    expect(assessed.polarities["no/refutes"]).toBe("refutes");
    expect(assessed.explanation_ids.sort()).toEqual(["no/refutes", "yes/supports"]);
  });

  it("exhausting the work bound yields open support, not exhaustive absence", () => {
    const templates = Array.from({ length: 8 }, (_, index) =>
      template(`alt-${String(index)}`, [`p-${String(index)}`], 10)
    );
    const assessed = assessEvidence(assessmentInput({
      observations: [
        observation({
          observation_id: "o",
          evidence_id: "e",
          premise_id: "p-9",
          proposition_id: "open-prop"
        })
      ],
      propositions: [demand("open-prop", "explanation", templates)],
      work_limit: 3
    }));
    expect(assessed.work_status).toBe("open");
    expect(assessed.records[0]?.claim).toBe("unknown");
    expect(assessed.explanation_ids).toEqual([]);
  });
});
