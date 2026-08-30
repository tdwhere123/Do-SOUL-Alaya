import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LexicalIntervalSourceReceiptCapturedV1 } from
  "../../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { isPsiCycleFailure, peelUndominated } from
  "../../../../../recall/decision/query-proof/frontier-peel.js";
import {
  collapseMeasurementGroup,
  createMeasurementGroupContractV1,
  issueMeasurementGroupAdmission,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  type VerifiedMeasurementAuthorityV1
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../../recall/decision/query-proof/measurement/lexical-interval-envelope.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import {
  comparePsiV2,
  peelPsiV2Frontiers,
  psiV2CandidateFromLexicalEnvelope,
  psiV2CycleCount,
  psiV2Dominates,
  resolvePsiV2ComparableVotes,
  type PsiV2CandidateV1,
  type PsiV2CoordinateV1
} from "../../../../../recall/decision/query-proof/dominance/index.js";
import { createNumericIntervalWitness } from
  "../../../../../recall/decision/query-proof/witness/index.js";
import {
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture,
  withCapturedLexicalMeasurementAuthorityFixture
} from "../measurement/prepared-authority-fixture.js";

const CONTRACT = LEXICAL_INTERVAL_MEASUREMENT_CONTRACT;
const PROVENANCE = Object.freeze([Object.freeze({
  source_id: "lexical.interval.primary",
  producer: "lexical.interval.adapter.v1"
})]);
let prepared: PreparedRecallRequest;

describe("proposition Psi v2", () => {
  beforeAll(async () => {
    prepared = await prepareMeasurementEvidenceFixture();
  });

  afterAll(() => releaseMeasurementEvidenceFixture(prepared));

  it("is irreflexive, asymmetric, and transitive on source-admitted intervals", async () => {
    await withField([["a", 0.9], ["b", 0.5], ["c", 0.1]], (authority, source) => {
      const strong = sourceCandidate("a", authority, source);
      const mid = sourceCandidate("b", authority, source);
      const weak = sourceCandidate("c", authority, source);
      expect(psiV2Dominates(strong, strong, [authority])).toBe(false);
      expect(psiV2Dominates(strong, mid, [authority])).toBe(true);
      expect(psiV2Dominates(mid, strong, [authority])).toBe(false);
      expect(psiV2Dominates(mid, weak, [authority])).toBe(true);
      expect(psiV2Dominates(strong, weak, [authority])).toBe(true);
      expect(comparePsiV2(strong, mid, [authority]).kind).toBe("dominates");
    });
  });

  it("keeps genuine multi-proposition trade-offs unresolved", () => {
    expect(resolvePsiV2ComparableVotes(["gt", "lt"]).kind).toBe("tradeoff");
  });

  it("blocks unknown and one-sided applicable coordinates", async () => {
    await withField([["a", 0.9], ["b", 0.1]], (authority, source) => {
      const admitted = sourceCandidate("a", authority, source);
      const unknown = candidate("b", [{
        proposition_id: "lex.interval",
        proposition_schema: CONTRACT.proposition_schema,
        applicable: true,
        identity: null,
        lex_domain: null,
        envelope_identity: null,
        admission: null,
        collapse: {
          status: "unresolved",
          reason: "unknown correlation blocks collapse",
          observations: []
        }
      }]);
      expect(comparePsiV2(admitted, unknown, [authority]).kind).toBe("blocked");
      const extra = { ...admitted.coordinates[0]!, proposition_id: "extra" };
      expect(comparePsiV2(
        candidate("a", [...admitted.coordinates, extra]),
        sourceCandidate("b", authority, source),
        [authority]
      ).kind).toBe("blocked");
    });
  });

  it("blocks lane, truncation, list size, and envelope identity mutation", async () => {
    await withField([["a", 0.9], ["b", 0.1]], (authority, source) => {
      const left = sourceCandidate("a", authority, source);
      const coordinate = sourceCandidate("b", authority, source).coordinates[0]!;
      const variants: PsiV2CoordinateV1[] = [
        { ...coordinate, lex_domain: { ...coordinate.lex_domain!, lane_id: "porter",
          raw_key_kind: "bm25_raw_rank" } },
        { ...coordinate, lex_domain: { ...coordinate.lex_domain!,
          status: coordinate.lex_domain!.status === "truncated" ? "complete" : "truncated" } },
        { ...coordinate, lex_domain: { ...coordinate.lex_domain!, list_n: 32 } },
        { ...coordinate, envelope_identity: {
          ...coordinate.envelope_identity!, query_run_id: "other-run"
        } }
      ];
      for (const variant of variants.slice(0, 3)) {
        expect(comparePsiV2(left, candidate(fieldKey("b"), [variant]), [authority]).kind)
          .toBe("blocked");
      }
      expect(comparePsiV2(left, candidate(fieldKey("b"), [variants[3]!]), [authority]).kind)
        .toBe("blocked");
    });
  });

  it("blocks unregistered contracts", async () => {
    await withField([["a", 0.9]], (authority) => {
      const forged = createMeasurementGroupContractV1({
        ...CONTRACT,
        contract_id: "psi.v2.numeric.forged"
      });
      const collapse = collapseOne(authority, "a", "lex.interval", 0.9, forged);
      expect(() => issueMeasurementGroupAdmission({
        authority,
        contract: forged,
        proposition_schema: forged.proposition_schema,
        collapse
      })).toThrow(/predeclared/u);
    });
  });

  it("blocks coordinate, candidate, schema, witness, and admission mutations", async () => {
    await withField([["a", 0.9], ["b", 0.1]], (authority, source) => {
      const left = sourceCandidate("a", authority, source);
      const right = sourceCandidate("b", authority, source);
      const coordinate = left.coordinates[0]!;
      if (coordinate.collapse.status !== "collapsed") throw new Error("collapse expected");
      const admission = coordinate.admission!;
      const mutations: PsiV2CandidateV1[] = [
        { ...left, candidate_id: "other-candidate" },
        candidate("a", [{ ...coordinate, proposition_id: "other-proposition" }]),
        candidate("a", [{ ...coordinate, proposition_schema: "lex.interval.drifted" }]),
        candidate("a", [{ ...coordinate, identity: {
          ...coordinate.identity!, request_digest: `sha256:${"e".repeat(64)}`
        } }]),
        candidate("a", [{ ...coordinate, admission: {
          ...admission, query_id: "other-query"
        } }]),
        candidate("a", [{ ...coordinate, collapse: {
          ...coordinate.collapse,
          witness: {
            ...coordinate.collapse.witness,
            identity: {
              ...coordinate.collapse.witness.identity,
              candidate_id: "other-candidate"
            }
          }
        } }])
      ];
      for (const mutated of mutations) {
        expect(comparePsiV2(mutated, right, [authority]).kind).toBe("blocked");
      }
    });
  });

  it("peels deterministic frontiers without mutating input", async () => {
    await withField([["a", 0.9], ["b", 0.5], ["c", 0.1]], (authority, source) => {
      const field = ["a", "b", "c"].map((key) => sourceCandidate(key, authority, source));
      const peeled = peelPsiV2Frontiers(field, [authority]);
      expect(isPsiCycleFailure(peeled)).toBe(false);
      if (!isPsiCycleFailure(peeled)) {
        expect(peeled.layers[0]?.member_keys).toEqual([fieldKey("a")]);
        expect(peeled.layers.flatMap((layer) => layer.member_keys).sort())
          .toEqual([fieldKey("a"), fieldKey("b"), fieldKey("c")]);
      }
      expect(field.map((row) => row.candidate_id))
        .toEqual([fieldKey("a"), fieldKey("b"), fieldKey("c")]);
      expect(psiV2CycleCount(peeled)).toBe(0);
    });
  });

  it("fails closed when the peel predicate cycles", () => {
    const cyclic = peelUndominated(["a", "b"], (left, right) => left !== right);
    expect(isPsiCycleFailure(cyclic)).toBe(true);
    expect(psiV2CycleCount(cyclic)).toBe(1);
  });
});

async function withField<T>(
  rows: readonly (readonly [string, number])[],
  work: (
    authority: VerifiedMeasurementAuthorityV1,
    source: LexicalIntervalSourceReceiptCapturedV1
  ) => Promise<T> | T
): Promise<T> {
  return await withCapturedLexicalMeasurementAuthorityFixture(
    prepared,
    rows.map(([candidate_key, normalized_rank]) => ({ candidate_key, normalized_rank })),
    async (authority, source) => {
      if (source.status !== "captured") throw new Error("captured source expected");
      return await work(authority, source);
    }
  );
}

function sourceCandidate(
  key: string,
  authority: VerifiedMeasurementAuthorityV1,
  source: LexicalIntervalSourceReceiptCapturedV1
): PsiV2CandidateV1 {
  const candidateKey = fieldKey(key);
  return psiV2CandidateFromLexicalEnvelope(
    candidateKey,
    lexicalIntervalSourceEnvelopes(source, candidateKey),
    authority
  );
}

function fieldKey(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

function collapseOne(
  authority: VerifiedMeasurementAuthorityV1,
  candidateId: string,
  propositionId: string,
  value: number,
  contract = CONTRACT
) {
  return collapseMeasurementGroup({
    contract,
    observations: [createNumericIntervalWitness({
      identity: {
        coordinate_id: `${propositionId}:${candidateId}`,
        query_id: authority.query_id,
        snapshot_digest: authority.snapshot_digest,
        candidate_id: candidateId,
        proposition_id: propositionId
      },
      provenance: PROVENANCE,
      epistemic: { kind: "exact" },
      payload: { lower: value, upper: value }
    })]
  });
}

function candidate(
  candidateId: string,
  coordinates: readonly PsiV2CoordinateV1[]
): PsiV2CandidateV1 {
  return Object.freeze({ candidate_id: candidateId, coordinates: Object.freeze(coordinates) });
}
