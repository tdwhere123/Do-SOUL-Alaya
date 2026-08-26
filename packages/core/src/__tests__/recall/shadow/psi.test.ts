import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  combineSubjectComponentEnvelopes,
  parseFieldMembership,
  parsePointwiseObservation,
  parseUnsupportedRelationalDiagnostic,
  ShadowContractError,
  shadowStatePairKind,
  SHADOW_PSI_OPERATOR_ID
} from "../../../recall/shadow/index.js";
import {
  cmpChannel,
  e0MembershipSubsetOfE1,
  eligibleCandidateKeys,
  emitPsiPair,
  isNotADominanceCompare,
  psiOutcome,
  psiPredicate,
  psiQ
} from "../../../recall/shadow/psi.js";
import {
  EMB,
  EMB_OTHER,
  EXACT_2,
  embeddingMissing,
  embeddingObserved,
  field,
  lexicalAt,
  lexicalObs,
  PORTER_3,
  PORTER_COMPLETE_10,
  PORTER_TRUNCATED,
  subjectComponent,
  subjectObs,
  temporalObserved,
  transitivityField,
  view
} from "./psi-test-support.js";

const LEX = ["lexical"] as const;
const TEMP = ["temporal"] as const;
const TEMP_EMB = ["temporal", "embedding"] as const;
const SUBJ = ["subject_preference"] as const;
const MAGNITUDE = [
  "observed",
  "not_applicable",
  "producer_unavailable",
  "not_observed"
] as const;
const SHADOW_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../recall/shadow"
);
const COMPLETE_WITNESSES = {
  query_requires: true,
  applicable: true,
  producer_available: true,
  candidate_evaluated: true,
  completeness_owner: "named.completeness.owner.v1",
  evaluation_exhausted: true,
  proven_absence: true
} as const;

describe("psiQ safe dominance", () => {
  it("is irreflexive", () => {
    const obs = field({ A: view({ lexical: lexicalAt("observed", 0.8) }) });
    expect(psiQ("A", "A", obs, LEX)).toBe(false);
  });

  it("returns not_a_dominance_compare for H-ineligible pairs", () => {
    const obs = field({
      A: view({ temporal: temporalObserved(0.9) }, "event"),
      B: view({ temporal: temporalObserved(0.5) })
    });
    expect(psiQ("A", "B", obs, TEMP)).toEqual({
      kind: "not_a_dominance_compare",
      reason: "h_ineligible",
      gate: "event",
      candidate_key: "A"
    });
    expect(eligibleCandidateKeys(obs)).toEqual(["B"]);
    expect(() => psiPredicate(obs, TEMP)("A", "B")).toThrow(/not a dominance compare/u);
  });

  it("membership-neutrality: graph admit cannot create a Psi edge", () => {
    const obs = field({
      A: view({ temporal: temporalObserved(0.75) }),
      B: view({ temporal: temporalObserved(0.75) })
    });
    const admitted = parseFieldMembership({
      candidate_key: "A",
      e0_member: true,
      e1_member: true,
      admits: ["fts.admit.v1", "graph.admit.v1"],
      embedding_admission: null
    });
    expect(admitted.admits).toContain("graph.admit.v1");
    expect(psiQ("A", "B", obs, TEMP)).toBe(false);
    expect(psiQ("B", "A", obs, TEMP)).toBe(false);
    expect(psiOutcome("A", "B", obs, TEMP).kind).toBe("equal");
  });

  it("excludes topology priors from preference", () => {
    const obs = field({
      A: view({ lexical: lexicalAt("observed", 0.4) }),
      B: view({ lexical: lexicalAt("observed", 0.4) })
    });
    const topology = { A: { degree: 3, activation: 1, winner: true }, B: { degree: 0 } };
    expect(topology.A.degree).toBeGreaterThan(topology.B.degree);
    expect(psiQ("A", "B", obs, LEX)).toBe(false);
    expect(psiQ("B", "A", obs, LEX)).toBe(false);
  });

  it("rejects Graph/Path/Flood O construction via parse", () => {
    for (const lineage of ["path", "flood", "graph", "relation"]) {
      expect(() => parsePointwiseObservation({ lineage })).toThrow(
        /relational observation is not admitted/u
      );
    }
    const diagnostic = parseUnsupportedRelationalDiagnostic({
      kind: "unsupported_relational_diagnostic",
      source: "flood",
      facts: { A_path: 1, final_score: 9 }
    });
    expect(diagnostic.source).toBe("flood");
  });

  it("no-admission-eviction: embed.admit does not create Psi", () => {
    const e0 = ["A", "B", "C"];
    const e1 = ["A", "B", "C", "D"];
    expect(e0MembershipSubsetOfE1(e0, e1)).toBe(true);
    expect(e0MembershipSubsetOfE1(["C"], ["A", "B"])).toBe(false);
    parseFieldMembership({
      candidate_key: "D",
      e0_member: false,
      e1_member: true,
      admits: ["embed.admit.v1"],
      embedding_admission: {
        receipt: "embed.admit.v1",
        membership_only: true,
        cannot_evict_e0: true
      }
    });
    const skip = { lexical: lexicalAt("not_applicable") };
    const obs = field({
      C: view(skip),
      D: view(skip)
    });
    expect(psiQ("D", "C", obs, LEX)).toBe(false);
    expect(psiQ("C", "D", obs, LEX)).toBe(false);
  });

  it("duplicate invariance: one lexical O, siblings are not a second axis", () => {
    const chosen = lexicalObs({ state: "observed", value: 0.8 }, PORTER_3);
    const weaker = lexicalObs({ state: "observed", value: 0.4 }, PORTER_3);
    const without = field({
      A: view({ lexical: chosen }),
      B: view({ lexical: weaker })
    });
    const withClone = field({
      A: view({ lexical: chosen }),
      Aprime: view({ lexical: chosen }),
      B: view({ lexical: weaker })
    });
    expect(psiQ("A", "B", without, LEX)).toBe(true);
    expect(psiQ("Aprime", "B", withClone, LEX)).toBe(true);
    expect(psiQ("A", "Aprime", withClone, LEX)).toBe(false);
  });

  it("sibling FTS cannot mint a second axis: cross-lane incomparable", () => {
    const obs = field({
      A: view({ lexical: lexicalObs({ state: "observed", value: 1 }, EXACT_2) }),
      B: view({ lexical: lexicalObs({ state: "observed", value: 1 }, PORTER_3) })
    });
    expect(cmpChannel(obs.A!.lineages.lexical!, obs.B!.lineages.lexical!))
      .toBe("incomparable");
    expect(psiQ("A", "B", obs, LEX)).toBe(false);
    expect(psiQ("B", "A", obs, LEX)).toBe(false);
    expect(psiOutcome("A", "B", obs, LEX).kind).toBe("blocked");
  });

  it.each(MAGNITUDE.flatMap((left) => MAGNITUDE.map((right) => ({ left, right }))))(
    "mixed-state matrix $left vs $right",
    ({ left, right }) => {
      const obs = field({
        V: view({ lexical: lexicalAt(left, 0.8) }),
        U: view({ lexical: lexicalAt(right, 0.8) })
      });
      const pair = shadowStatePairKind(left, right);
      const outcome = psiOutcome("V", "U", obs, LEX);
      expect(isNotADominanceCompare(psiQ("V", "U", obs, LEX))).toBe(false);
      if (pair === "skip") expect(outcome.kind).toBe("skip");
      if (pair === "incomparable") expect(outcome.kind).toBe("blocked");
      if (pair === "numeric") expect(outcome.kind).toBe("equal");
      expect(psiQ("V", "U", obs, LEX)).toBe(false);
    }
  );

  it("partial subject unknown keeps the lineage unknown and blocks", () => {
    const unknownPref = subjectComponent("preference", {
      state: "not_observed",
      reason: "not_run"
    });
    const observedSelf = subjectComponent("self_reference", {
      state: "observed",
      value: 0.7
    });
    expect(combineSubjectComponentEnvelopes([unknownPref, observedSelf]).state)
      .toBe("not_observed");
    const obs = field({
      A: view({
        subject_preference: subjectObs({ state: "not_observed", reason: "not_run" }, [
          unknownPref,
          observedSelf
        ])
      }),
      B: view({
        subject_preference: subjectObs({ state: "observed", value: 0.9 }, [
          subjectComponent("self_reference", { state: "observed", value: 0.9 })
        ])
      })
    });
    expect(psiQ("A", "B", obs, SUBJ)).toBe(false);
    expect(psiOutcome("A", "B", obs, SUBJ).kind).toBe("blocked");
  });

  it("candidate-N/A versus unavailable is incomparable, not skip", () => {
    const unavailablePref = subjectComponent("preference", {
      state: "not_observed", reason: "not_run"
    });
    const self = subjectComponent("self_reference", { state: "observed", value: 0.7 });
    expect(combineSubjectComponentEnvelopes([unavailablePref, self]).state)
      .toBe("not_observed");
    const obs = field({
      A: view({
        subject_preference: subjectObs({ state: "not_observed", reason: "not_run" }, [
          unavailablePref,
          self
        ])
      }),
      B: view({
        subject_preference: subjectObs({ state: "not_applicable" }, [])
      })
    });
    expect(psiOutcome("A", "B", obs, SUBJ).kind).toBe("blocked");
    const onlySelf = field({
      C: view({
        subject_preference: subjectObs({ state: "observed", value: 0.7 }, [
          subjectComponent("preference", { state: "not_applicable" }),
          self
        ])
      })
    });
    expect(onlySelf.C?.lineages.subject_preference?.envelope).toEqual({
      state: "observed",
      value: 0.7
    });
  });

  it("truncated vs complete LexDomain is incomparable", () => {
    const obs = field({
      A: view({
        lexical: lexicalObs({ state: "observed", value: 1 }, PORTER_TRUNCATED)
      }),
      B: view({
        lexical: lexicalObs({ state: "observed", value: 1 }, PORTER_COMPLETE_10)
      })
    });
    expect(psiQ("A", "B", obs, LEX)).toBe(false);
    expect(psiQ("B", "A", obs, LEX)).toBe(false);
    expect(psiOutcome("A", "B", obs, LEX).kind).toBe("blocked");
  });

  it("same truncated LexDomain remains comparable", () => {
    const obs = field({
      A: view({
        lexical: lexicalObs({ state: "observed", value: 1 }, PORTER_TRUNCATED)
      }),
      B: view({
        lexical: lexicalObs({ state: "observed", value: 0.4 }, PORTER_TRUNCATED)
      })
    });
    expect(psiQ("A", "B", obs, LEX)).toBe(true);
    expect(cmpChannel(obs.A!.lineages.lexical!, obs.B!.lineages.lexical!)).toBe("gt");
  });

  it("cap/not-run/unavailable cannot mint required_but_missing as lexical magnitude", () => {
    expect(() => lexicalObs({
      state: "required_but_missing",
      witnesses: COMPLETE_WITNESSES
    }, null)).toThrow(/pointwise magnitude/u);
  });

  it("unavailable/cap/not-run are unknown-neutral skip when symmetric", () => {
    const obs = field({
      A: view({ lexical: lexicalObs({ state: "producer_unavailable" }, null) }),
      B: view({
        lexical: lexicalObs({ state: "not_observed", reason: "cap_exhausted" }, null)
      }),
      C: view({
        lexical: lexicalObs({ state: "not_observed", reason: "not_run" }, null)
      }),
      D: view({
        lexical: lexicalObs({ state: "not_observed", reason: "truncated" }, null)
      })
    });
    expect(psiOutcome("A", "B", obs, LEX).kind).toBe("blocked");
    expect(psiOutcome("C", "D", obs, LEX).kind).toBe("skip");
    expect(psiQ("C", "D", obs, LEX)).toBe(false);
  });

  it("transitivity of a 3-chain", () => {
    const obs = transitivityField();
    expect(psiQ("A", "B", obs, TEMP_EMB)).toBe(true);
    expect(psiQ("B", "C", obs, TEMP_EMB)).toBe(true);
    expect(psiQ("A", "C", obs, TEMP_EMB)).toBe(true);
    expect(psiQ("B", "A", obs, TEMP_EMB)).toBe(false);
  });


  it("rejects weak-skip Pareto: asymmetric missingness blocks", () => {
    const obs = field({
      A: view({
        lexical: lexicalAt("observed", 0.9),
        embedding: embeddingObserved(0.1)
      }),
      B: view({
        lexical: lexicalAt("observed", 0.8),
        embedding: embeddingMissing()
      }),
      C: view({
        lexical: lexicalAt("observed", 0.7),
        embedding: embeddingObserved(0.9)
      })
    });
    const channels = ["lexical", "embedding"] as const;
    expect(psiQ("A", "B", obs, channels)).toBe(false);
    expect(psiQ("B", "C", obs, channels)).toBe(false);
    expect(psiOutcome("A", "C", obs, channels).kind).toBe("tradeoff");
  });

  it("E0/E1 refinement: masking embedding recovers E0", () => {
    const obs = field({
      A: view({
        temporal: temporalObserved(0.5),
        embedding: embeddingObserved(0.9)
      }),
      B: view({
        temporal: temporalObserved(0.5),
        embedding: embeddingMissing()
      })
    });
    expect(psiOutcome("A", "B", obs, TEMP).kind).toBe("equal");
    expect(psiQ("A", "B", obs, TEMP)).toBe(false);
    expect(psiOutcome("A", "B", obs, TEMP_EMB).kind).toBe("blocked");
    expect(psiQ("A", "B", obs, TEMP_EMB)).toBe(false);
  });

  it("missing embedding is incomparable, not mid-scale", () => {
    const obs = field({
      A: view({ embedding: embeddingObserved(0.4) }),
      B: view({ embedding: embeddingMissing() })
    });
    expect(psiQ("A", "B", obs, ["embedding"])).toBe(false);
    expect(psiQ("B", "A", obs, ["embedding"])).toBe(false);
    expect(psiOutcome("A", "B", obs, ["embedding"]).kind).toBe("blocked");
  });

  it("embedding domain mismatch is incomparable", () => {
    const obs = field({
      A: view({ embedding: embeddingObserved(0.9, EMB) }),
      B: view({ embedding: embeddingObserved(0.1, EMB_OTHER) })
    });
    expect(psiOutcome("A", "B", obs, ["embedding"]).kind).toBe("blocked");
  });

  it("empty evidence and equal channels do not dominate", () => {
    const skip = field({
      A: view({ lexical: lexicalAt("not_applicable") }),
      B: view({ lexical: lexicalAt("not_applicable") })
    });
    expect(psiOutcome("A", "B", skip, LEX).kind).toBe("skip");
    expect(psiQ("A", "B", skip, [])).toBe(false);
    const equal = field({
      A: view({ lexical: lexicalAt("observed", 0.5) }),
      B: view({ lexical: lexicalAt("observed", 0.5) })
    });
    expect(psiOutcome("A", "B", equal, LEX).kind).toBe("equal");
    const emission = emitPsiPair("A", "B", equal, LEX);
    expect("reason" in emission && emission.reason).toBe("equal");
  });

  it("emits a Psi edge when v strictly dominates u", () => {
    const obs = field({
      A: view({ lexical: lexicalAt("observed", 0.9) }),
      B: view({ lexical: lexicalAt("observed", 0.2) })
    });
    const emission = emitPsiPair("A", "B", obs, LEX);
    expect(emission).toMatchObject({
      kind: "psi_edge",
      operator_id: SHADOW_PSI_OPERATOR_ID,
      dominator: "A",
      dominated: "B"
    });
  });

  it("routes observed_negative / required_but_missing as Cmp contract failure", () => {
    const negative = subjectComponent("preference", {
      state: "observed_negative",
      named_consumer: "h_event"
    });
    const missing = subjectComponent("preference", {
      state: "required_but_missing", witnesses: COMPLETE_WITNESSES
    });
    expect(() => subjectObs(missing.envelope, [missing]))
      .toThrow(/authority state mismatch/u);
    const obs = field({
      A: view({ subject_preference: subjectObs(negative.envelope, [negative]) }),
      B: view({
        subject_preference: subjectObs({ state: "not_observed", reason: "not_run" }, [
          subjectComponent("preference", { state: "not_observed", reason: "not_run" })
        ])
      })
    });
    expect(() => psiQ("A", "B", obs, SUBJ)).toThrow(ShadowContractError);
  });

  it("empty applicable subject set is not_applicable, never a vacuous max", () => {
    const empty = subjectObs({ state: "not_applicable" }, []);
    expect(empty.envelope.state).toBe("not_applicable");
    const obs = field({
      A: view({ subject_preference: empty }),
      B: view({ subject_preference: empty })
    });
    expect(psiOutcome("A", "B", obs, SUBJ).kind).toBe("skip");
  });

  it("does not import production Select_Gamma or safe-dominance", () => {
    const src = readFileSync(join(SHADOW_DIR, "psi.ts"), "utf8");
    expect(src).not.toMatch(/selectGammaWalk/u);
    expect(src).not.toMatch(/assessSafeCandidateDominance/u);
    expect(src).not.toMatch(/deliverFineAssessment/u);
    expect(src).not.toMatch(/\?\?\s*0(?:\.5)?/u);
  });
});
