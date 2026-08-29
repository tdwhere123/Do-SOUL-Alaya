import { describe, expect, it } from "vitest";
import { d1LaneEnvelopes } from "../../../../recall/shadow/d1/index.js";
import type { D1EnvelopeIdentity } from "../../../../recall/shadow/d1/legal-envelope.js";
import { isPsiCycleFailure, peelUndominated } from
  "../../../../recall/shadow/frontier-peel.js";
import {
  collapseMeasurementGroup,
  createMeasurementGroupContractV1,
  type MeasurementGroupContractV1
} from "../../../../recall/shadow/measurement/index.js";
import type { LexDomain } from "../../../../recall/shadow/observations.js";
import {
  comparePsiV2,
  peelPsiV2Frontiers,
  psiV2CandidateFromLexicalEnvelope,
  psiV2CycleCount,
  psiV2Dominates,
  rawMissingFamilyFragment,
  type PsiV2CandidateV1
} from "../../../../recall/shadow/psi-v2/index.js";
import { createNumericIntervalWitness } from "../../../../recall/shadow/witness/index.js";
import { D1_SNAPSHOT, plantProof } from "../d1/d1-proof-fixture.js";
import { PINS, PROV } from "../witness/fixtures.js";

const CONTRACT = createMeasurementGroupContractV1({
  contract_id: "psi.v2.numeric",
  operator_version: "1",
  proposition_schema: "support",
  measurement_domain: "numeric_interval",
  comparison_direction: "higher_is_stronger",
  correlation_policy: "identity_dedupe",
  combine_operator: "bound_intersection",
  soundness_preconditions: ["same_binding"],
  upper_bound_rule: "interval_upper"
});

const EXACT_CONTRACT = createMeasurementGroupContractV1({
  ...CONTRACT,
  contract_id: "psi.v2.numeric.exact",
  comparison_direction: "exact"
});

const EXACT_DOMAIN: LexDomain = {
  lane_id: "exact",
  list_n: 8,
  status: "complete",
  raw_key_kind: "matched_token_count"
};

const PORTER_DOMAIN: LexDomain = {
  lane_id: "porter",
  list_n: 8,
  status: "complete",
  raw_key_kind: "bm25_raw_rank"
};

const ENVELOPE_IDENTITY: D1EnvelopeIdentity = {
  field_prefix: "lexical_relaxed",
  query_run_id: "memory.keyword.depth:10",
  snapshot_digest: D1_SNAPSHOT,
  request_digest: `sha256:${"c".repeat(64)}`,
  workspace_id: "workspace-1"
};

describe("proposition Psi v2", () => {
  it("is irreflexive, asymmetric, and transitive on collapsed intervals", () => {
    const strong = candidate("a", [["p", 5, 5]]);
    const mid = candidate("b", [["p", 3, 3]]);
    const weak = candidate("c", [["p", 1, 1]]);
    expect(psiV2Dominates(strong, strong)).toBe(false);
    expect(psiV2Dominates(strong, mid)).toBe(true);
    expect(psiV2Dominates(mid, strong)).toBe(false);
    expect(psiV2Dominates(strong, weak)).toBe(true);
    expect(comparePsiV2(strong, mid).kind).toBe("dominates");
  });

  it("keeps genuine trade-offs unresolved and blocks on unknown collapse", () => {
    const mixed = candidate("a", [["p", 9, 9], ["q", 1, 1]]);
    const other = candidate("b", [["p", 1, 1], ["q", 9, 9]]);
    expect(comparePsiV2(mixed, other).kind).toBe("tradeoff");
    const blocked = candidate("c", [["p", 9, 9]]);
    const unknown: PsiV2CandidateV1 = {
      candidate_id: "d",
      coordinates: [{
        proposition_id: "p",
        applicable: true,
        lex_domain: null,
        envelope_identity: null,
        collapse: {
          status: "unresolved",
          reason: "unknown correlation blocks collapse",
          observations: []
        }
      }]
    };
    expect(comparePsiV2(blocked, unknown).kind).toBe("blocked");
  });

  it("does not treat overlap plus another equal coordinate as equality or dominance", () => {
    const overlapping = candidate("a", [["p", 3, 5], ["q", 1, 1]]);
    const other = candidate("b", [["p", 4, 6], ["q", 1, 1]]);
    expect(comparePsiV2(overlapping, other).kind).toBe("incomparable");
  });

  it("blocks a pair when one side has an extra applicable coordinate", () => {
    const extra = candidate("a", [["p", 5, 5], ["q", 2, 2]]);
    const base = candidate("b", [["p", 5, 5]]);
    expect(comparePsiV2(extra, base).kind).toBe("blocked");
    expect(comparePsiV2(base, extra).kind).toBe("blocked");
  });

  it("treats exact-direction disagreement as incomparable, not dominance", () => {
    const five = candidate("a", [["p", 5, 5]], { contract: EXACT_CONTRACT });
    const one = candidate("b", [["p", 1, 1]], { contract: EXACT_CONTRACT });
    expect(comparePsiV2(five, one).kind).toBe("incomparable");
    expect(psiV2Dominates(five, one)).toBe(false);
  });

  it("compares only coordinates bound to the identical measurement contract", () => {
    const variants: readonly [string, MeasurementGroupContractV1][] = [
      ["contract id", createMeasurementGroupContractV1({
        ...CONTRACT,
        contract_id: "psi.v2.numeric.other"
      })],
      ["operator version", createMeasurementGroupContractV1({
        ...CONTRACT,
        operator_version: "2"
      })],
      ["combine operator", createMeasurementGroupContractV1({
        ...CONTRACT,
        combine_operator: "exact_agreement"
      })]
    ];

    for (const [label, variant] of variants) {
      const strong = candidate("a", [["p", 5, 5]]);
      const weak = candidate("b", [["p", 1, 1]], { contract: variant });
      expect(comparePsiV2(strong, weak), label).toMatchObject({ kind: "incomparable" });
      expect(psiV2Dominates(strong, weak), label).toBe(false);
    }

    const identical = candidate("b", [["p", 1, 1]], { contract: CONTRACT });
    expect(comparePsiV2(candidate("a", [["p", 5, 5]]), identical).kind)
      .toBe("dominates");
  });

  it("blocks comparison when measurement contract metadata is missing", () => {
    const missingContractId = {
      ...CONTRACT,
      contract_id: undefined
    } as unknown as MeasurementGroupContractV1;
    const strong = candidate("a", [["p", 5, 5]]);
    const unknown = candidate("b", [["p", 1, 1]], { contract: missingContractId });

    expect(comparePsiV2(strong, unknown).kind).toBe("blocked");
    expect(psiV2Dominates(strong, unknown)).toBe(false);
  });

  it("blocks two identically forged contracts whose digest does not bind their metadata", () => {
    const forged = {
      ...CONTRACT,
      contract_id: "psi.v2.numeric.forged"
    };
    const strong = candidate("a", [["p", 5, 5]], { contract: forged });
    const weak = candidate("b", [["p", 1, 1]], { contract: forged });

    expect(comparePsiV2(strong, weak).kind).toBe("blocked");
    expect(psiV2Dominates(strong, weak)).toBe(false);
  });

  it("is incomparable across D1 lane, list_n, truncation, and identity", () => {
    const exactProof = plantProof({
      lanes: { exact: { rows: [{ key: "hit", ordinal: 5 }], universeKeys: ["hit"] } }
    });
    const porterProof = plantProof({
      lanes: { porter: { rows: [{ key: "other", ordinal: 1 }], universeKeys: ["other"] } }
    });
    const exactHit = fromProof("hit", exactProof);
    const porterOther = fromProof("other", porterProof);
    expect(comparePsiV2(exactHit, porterOther).kind).toBe("incomparable");
    const complete = candidate("a", [["lex.interval", 5, 5]], {
      domain: PORTER_DOMAIN,
      identity: ENVELOPE_IDENTITY
    });
    const truncated = candidate("b", [["lex.interval", 1, 1]], {
      domain: { ...PORTER_DOMAIN, status: "truncated" },
      identity: ENVELOPE_IDENTITY
    });
    expect(comparePsiV2(complete, truncated).kind).toBe("incomparable");
    const shortList = candidate("c", [["lex.interval", 5, 5]], {
      domain: EXACT_DOMAIN,
      identity: ENVELOPE_IDENTITY
    });
    const longList = candidate("d", [["lex.interval", 1, 1]], {
      domain: { ...EXACT_DOMAIN, list_n: 32 },
      identity: ENVELOPE_IDENTITY
    });
    expect(comparePsiV2(shortList, longList).kind).toBe("incomparable");
    const otherIdentity = candidate("e", [["lex.interval", 1, 1]], {
      domain: EXACT_DOMAIN,
      identity: { ...ENVELOPE_IDENTITY, query_run_id: "memory.keyword.depth:2" }
    });
    expect(comparePsiV2(shortList, otherIdentity).kind).toBe("incomparable");
  });

  it("does not let a missing raw family fragment veto after lawful collapse", () => {
    const identity = ENVELOPE_IDENTITY;
    const strongMap = lexicalMap(9, 9, identity, { porter: [4, 4] });
    const weakMap = lexicalMap(1, 1, identity);
    expect(rawMissingFamilyFragment(strongMap, weakMap)).toBe(true);
    const strong = psiV2CandidateFromLexicalEnvelope(
      "a",
      strongMap,
      identity.query_run_id,
      D1_SNAPSHOT
    );
    const weak = psiV2CandidateFromLexicalEnvelope(
      "b",
      weakMap,
      identity.query_run_id,
      D1_SNAPSHOT
    );
    expect(comparePsiV2(strong, weak).kind).toBe("dominates");
  });

  it("peels deterministic frontiers without deleting dominated candidates from the input", () => {
    const field = [
      candidate("a", [["p", 5, 5]]),
      candidate("b", [["p", 3, 3]]),
      candidate("c", [["p", 1, 1]])
    ];
    const peeled = peelPsiV2Frontiers(field);
    expect(isPsiCycleFailure(peeled)).toBe(false);
    if (!isPsiCycleFailure(peeled)) {
      expect(peeled.layers[0]?.member_keys).toEqual(["a"]);
      expect(peeled.layers.map((layer) => layer.member_keys).flat().sort()).toEqual(["a", "b", "c"]);
    }
    expect(field.map((row) => row.candidate_id)).toEqual(["a", "b", "c"]);
    expect(psiV2CycleCount(peeled)).toBe(0);
  });

  it("fails closed when the peel predicate cycles", () => {
    const cyclic = peelUndominated(["a", "b"], (left, right) => left !== right);
    expect(isPsiCycleFailure(cyclic)).toBe(true);
    expect(psiV2CycleCount(cyclic)).toBe(1);
  });
});

function fromProof(key: string, proof: ReturnType<typeof plantProof>): PsiV2CandidateV1 {
  const map = d1LaneEnvelopes(proof, key);
  return psiV2CandidateFromLexicalEnvelope(
    key,
    map,
    map.query_run_id ?? "",
    D1_SNAPSHOT
  );
}

function candidate(
  id: string,
  rows: readonly [string, number, number][],
  options: {
    readonly domain?: LexDomain | null;
    readonly identity?: D1EnvelopeIdentity | null;
    readonly contract?: MeasurementGroupContractV1;
  } = {}
): PsiV2CandidateV1 {
  return {
    candidate_id: id,
    coordinates: rows.map(([propositionId, lower, upper]) => ({
      proposition_id: propositionId,
      applicable: true,
      lex_domain: options.domain ?? null,
      envelope_identity: options.identity ?? null,
      collapse: collapseOne(id, propositionId, lower, upper, options.contract ?? CONTRACT)
    }))
  };
}

function collapseOne(
  candidateId: string,
  propositionId: string,
  lower: number,
  upper: number,
  contract: MeasurementGroupContractV1
) {
  return collapseMeasurementGroup({
    contract,
    observations: [
      createNumericIntervalWitness({
        identity: {
          ...PINS,
          coordinate_id: `${candidateId}:${propositionId}`,
          candidate_id: candidateId,
          proposition_id: propositionId
        },
        provenance: PROV,
        epistemic: { kind: "exact" },
        payload: { lower, upper }
      })
    ]
  });
}

function lexicalMap(
  lower: number,
  upper: number,
  identity: D1EnvelopeIdentity | null,
  extra: { readonly porter?: readonly [number, number] } = {}
) {
  return {
    identity,
    field_prefix: identity?.field_prefix ?? null,
    query_run_id: identity?.query_run_id ?? null,
    snapshot_digest: identity?.snapshot_digest ?? null,
    request_digest: identity?.request_digest ?? null,
    primary: {
      domain: EXACT_DOMAIN,
      envelope: { kind: "interval" as const, lower, upper }
    },
    lanes: extra.porter === undefined ? {} : {
      porter: {
        domain: PORTER_DOMAIN,
        value: { kind: "interval" as const, lower: extra.porter[0], upper: extra.porter[1] }
      }
    }
  };
}
