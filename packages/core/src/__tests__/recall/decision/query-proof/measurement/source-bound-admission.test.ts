import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import type { RecallReadSnapshotPort } from
  "../../../../../recall/runtime/recall-read-snapshot.js";
import type { LexicalIntervalSourceReceiptCapturedV1 } from
  "../../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../../recall/decision/query-proof/measurement/lexical-interval-envelope.js";
import {
  collapsedMeasurementCoordinateId,
  collapseMeasurementGroup,
  issueMeasurementGroupAdmission,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  LEXICAL_INTERVAL_PROPOSITION_ID,
  validateMeasurementAdmissionV1,
  type MeasurementCollapseV1,
  type VerifiedMeasurementAuthorityV1
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import { comparePsiV2, psiV2CandidateFromLexicalEnvelope } from
  "../../../../../recall/decision/query-proof/dominance/index.js";
import type { PsiV2CoordinateV1 } from
  "../../../../../recall/decision/query-proof/dominance/index.js";
import { createNumericIntervalWitness } from
  "../../../../../recall/decision/query-proof/witness/index.js";
import type { WitnessProvenanceEntry } from
  "../../../../../recall/decision/query-proof/witness/index.js";
import {
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture,
  withCapturedLexicalMeasurementAuthorityFixture
} from "./prepared-authority-fixture.js";

const CONTRACT = LEXICAL_INTERVAL_MEASUREMENT_CONTRACT;
const PROVENANCE = Object.freeze([Object.freeze({
  source_id: "lexical.interval.primary",
  producer: "lexical.interval.adapter.v1"
})]);
let prepared: PreparedRecallRequest;

describe("source-bound lexical measurement admission", () => {
  beforeAll(async () => {
    prepared = await prepareMeasurementEvidenceFixture();
  });

  afterAll(() => releaseMeasurementEvidenceFixture(prepared));

  it("admits captured candidate bytes inside the active read and reaches Psi", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(prepared, [
      { candidate_key: "cand-a", normalized_rank: 1 },
      { candidate_key: "cand-b", normalized_rank: 0.5 }
    ], (authority, source) => {
      if (source.status !== "captured") throw new Error("captured source expected");
      const leftKey = fieldKey("cand-a");
      const rightKey = fieldKey("cand-b");
      const left = psiV2CandidateFromLexicalEnvelope(
        leftKey, lexicalIntervalSourceEnvelopes(source, leftKey), authority
      );
      const right = psiV2CandidateFromLexicalEnvelope(
        rightKey, lexicalIntervalSourceEnvelopes(source, rightKey), authority
      );
      const coordinate = left.coordinates[0]!;
      expect(coordinate.admission).not.toBeNull();
      if (coordinate.collapse.status !== "collapsed") {
        throw new Error("production lexical collapse expected");
      }
      expect(coordinate.collapse.witness.identity.coordinate_id).toBe(
        collapsedMeasurementCoordinateId(LEXICAL_INTERVAL_PROPOSITION_ID)
      );
      const envelope = lexicalIntervalSourceEnvelopes(source, leftKey);
      for (const coordinateId of ["x", `${LEXICAL_INTERVAL_PROPOSITION_ID}:${leftKey}`]) {
        const forged = {
          ...coordinate.collapse,
          witness: {
            ...coordinate.collapse.witness,
            identity: { ...coordinate.collapse.witness.identity, coordinate_id: coordinateId }
          }
        } as MeasurementCollapseV1;
        expectIssueBlocked(authority, forged, envelope);
      }
      expect(comparePsiV2(left, right, [authority]).kind).toBe("dominates");
    });
  });

  it("rejects empty, wrong-candidate, wrong-value, and wrong-provenance collapses", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-a", normalized_rank: 1 }],
      (authority, source) => {
        if (source.status !== "captured") throw new Error("captured source expected");
        const key = fieldKey("cand-a");
        const envelope = lexicalIntervalSourceEnvelopes(source, key);
        expectIssueBlocked(authority, collapse(authority, fieldKey("cand-missing"), 0.9), envelope);
        expectIssueBlocked(authority, collapse(authority, key, 0.8), envelope);
        expectIssueBlocked(authority, collapse(authority, key, 0.9, [{
          source_id: "lexical.interval.primary",
          producer: "caller.forged"
        }]), envelope);
        expectIssueBlocked(authority, collapse(authority, key, 0.9, [
          ...PROVENANCE,
          { source_id: "lexical.interval.extra", producer: "caller.extra" }
        ]), envelope);
      }
    );
    await withCapturedLexicalMeasurementAuthorityFixture(prepared, [], (authority) => {
      expectIssueBlocked(authority, collapse(authority, "cand-a", 0.9));
    });
  });

  it("rejects scope, kind, lane, status, list, and raw-kind relabeling", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "shared", normalized_rank: 1 }],
      (authority, source) => {
        if (source.status !== "captured") throw new Error("captured source expected");
        const key = fieldKey("shared");
        const envelope = lexicalIntervalSourceEnvelopes(source, key);
        expect(psiV2CandidateFromLexicalEnvelope(key, envelope, authority)
          .coordinates[0]?.admission).not.toBeNull();
        for (const alias of [
          "shared",
          "global:memory_entry:shared",
          "workspace_local:evidence_capsule:shared",
          "workspace_local:synthesis_capsule:shared"
        ]) {
          const aliased = lexicalIntervalSourceEnvelopes(source, alias);
          expect(aliased.primary).toBeNull();
          expect(psiV2CandidateFromLexicalEnvelope(alias, aliased, authority)
            .coordinates[0]?.admission).toBeNull();
        }
        const domain = envelope.primary!.domain;
        const mutations = [
          { ...domain, lane_id: "porter" as const, raw_key_kind: "bm25_raw_rank" as const },
          { ...domain, status: "truncated" as const },
          { ...domain, list_n: domain.list_n + 1 },
          { ...domain, raw_key_kind: "bm25_raw_rank" as const }
        ];
        for (const mutated of mutations) {
          const relabeled = { ...envelope, primary: { ...envelope.primary!, domain: mutated } };
          expect(psiV2CandidateFromLexicalEnvelope(key, relabeled, authority)
            .coordinates[0]?.admission).toBeNull();
        }
      }
    );
  });

  it("invalidates authority and admissions after commit", async () => {
    const issued = await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-a", normalized_rank: 1 }],
      (authority, source) => {
        if (source.status !== "captured") throw new Error("captured source expected");
        const coordinate = sourceCoordinate(authority, source, "cand-a");
        const collapse = coordinate.collapse;
        if (!isNumericCollapse(collapse) || coordinate.admission === null) {
          throw new Error("admitted source coordinate expected");
        }
        const measured: MeasurementCollapseV1 = collapse;
        return { authority, measured,
          admission: coordinate.admission, coordinate };
      }
    );
    expectIssueBlocked(issued.authority, issued.measured);
    expect(validateMeasurementAdmissionV1({
      admission: issued.admission,
      current_authorities: [issued.authority],
      contract: CONTRACT,
      proposition_schema: CONTRACT.proposition_schema,
      collapse: issued.measured,
      lexical_source: {
        lex_domain: issued.coordinate.lex_domain,
        envelope_identity: issued.coordinate.envelope_identity
      }
    }).status).toBe("blocked");
  });

  it("invalidates authority after rollback", async () => {
    let authority: VerifiedMeasurementAuthorityV1 | undefined;
    let measured: MeasurementCollapseV1 | undefined;
    const snapshot: RecallReadSnapshotPort = {
      beginDeferred() {},
      commit() {},
      rollback() {}
    };
    await expect(withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-a", normalized_rank: 1 }],
      (current) => {
        authority = current;
        measured = collapse(current, "cand-a", 1);
        throw new Error("force rollback");
      },
      snapshot
    )).rejects.toThrow("force rollback");
    expectIssueBlocked(authority!, measured!);
  });

  it("binds admission to the exact authority object, not an equal digest", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-a", normalized_rank: 1 }],
      async (first, source) => {
        if (source.status !== "captured") throw new Error("captured source expected");
        const coordinate = sourceCoordinate(first, source, "cand-a");
        const collapse = coordinate.collapse;
        if (!isNumericCollapse(collapse) || coordinate.admission === null) {
          throw new Error("admitted source coordinate expected");
        }
        const measured: MeasurementCollapseV1 = collapse;
        const admission = coordinate.admission;
        await withCapturedLexicalMeasurementAuthorityFixture(
          prepared,
          [{ candidate_key: "cand-a", normalized_rank: 1 }],
          (second) => {
            expect(second).not.toBe(first);
            expect(second.authority_digest).toBe(first.authority_digest);
            expect(validateMeasurementAdmissionV1({
              admission,
              current_authorities: [second],
              contract: CONTRACT,
              proposition_schema: CONTRACT.proposition_schema,
              collapse: measured,
              lexical_source: {
                lex_domain: coordinate.lex_domain,
                envelope_identity: coordinate.envelope_identity
              }
            }).status).toBe("blocked");
            expectIssueBlocked({ ...first } as VerifiedMeasurementAuthorityV1, measured);
            expect(validateMeasurementAdmissionV1({
              admission: { ...admission },
              current_authorities: [first],
              contract: CONTRACT,
              proposition_schema: CONTRACT.proposition_schema,
              collapse: measured,
              lexical_source: {
                lex_domain: coordinate.lex_domain,
                envelope_identity: coordinate.envelope_identity
              }
            }).status).toBe("blocked");
          }
        );
      }
    );
  });
});

function collapse(
  authority: VerifiedMeasurementAuthorityV1,
  candidateId: string,
  value: number,
  provenance: readonly WitnessProvenanceEntry[] = PROVENANCE
): MeasurementCollapseV1 {
  return collapseMeasurementGroup({
    contract: CONTRACT,
    observations: [createNumericIntervalWitness({
      identity: {
        coordinate_id: `lex.interval:${candidateId}`,
        query_id: authority.query_id,
        snapshot_digest: authority.snapshot_digest,
        candidate_id: candidateId,
        proposition_id: "lex.interval"
      },
      provenance,
      epistemic: { kind: "exact" },
      payload: { lower: value, upper: value }
    })]
  });
}

function issue(
  authority: VerifiedMeasurementAuthorityV1,
  measured: MeasurementCollapseV1,
  envelope?: ReturnType<typeof lexicalIntervalSourceEnvelopes>
) {
  if (measured.status !== "collapsed") {
    throw new Error(measured.status === "unresolved" ? measured.reason : "conflict");
  }
  return issueMeasurementGroupAdmission({
    authority,
    contract: CONTRACT,
    proposition_schema: CONTRACT.proposition_schema,
    collapse: measured,
    lexical_source: envelope?.primary === null || envelope?.identity === null ||
        envelope === undefined ? undefined : {
      envelope,
      lex_domain: envelope.primary.domain,
      envelope_identity: envelope.identity
    }
  });
}

function expectIssueBlocked(
  authority: VerifiedMeasurementAuthorityV1,
  measured: MeasurementCollapseV1,
  envelope?: ReturnType<typeof lexicalIntervalSourceEnvelopes>
): void {
  expect(() => issue(authority, measured, envelope)).toThrow();
}

function sourceCoordinate(
  authority: VerifiedMeasurementAuthorityV1,
  source: LexicalIntervalSourceReceiptCapturedV1,
  objectId: string
) {
  const key = fieldKey(objectId);
  return psiV2CandidateFromLexicalEnvelope(
    key, lexicalIntervalSourceEnvelopes(source, key), authority
  ).coordinates[0]!;
}

function fieldKey(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}

function isNumericCollapse(
  collapse: PsiV2CoordinateV1["collapse"]
): collapse is Extract<MeasurementCollapseV1, { status: "collapsed" }> {
  return collapse.status === "collapsed" && collapse.witness.domain === "numeric_interval";
}
