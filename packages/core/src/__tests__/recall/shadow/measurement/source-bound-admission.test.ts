import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import type { RecallReadSnapshotPort } from
  "../../../../recall/runtime/recall-read-snapshot.js";
import type { LexicalIntervalSourceReceiptCapturedV1 } from
  "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../recall/shadow/measurement/lexical-interval-envelope.js";
import {
  collapseMeasurementGroup,
  issueMeasurementGroupAdmission,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  validateMeasurementAdmissionV1,
  type MeasurementCollapseV1,
  type VerifiedMeasurementAuthorityV1
} from "../../../../recall/shadow/measurement/index.js";
import { comparePsiV2, psiV2CandidateFromLexicalEnvelope } from
  "../../../../recall/shadow/psi-v2/index.js";
import { createNumericIntervalWitness } from
  "../../../../recall/shadow/witness/index.js";
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
      { candidate_key: "cand-a", normalized_rank: 0.9 },
      { candidate_key: "cand-b", normalized_rank: 0.4 }
    ], (authority, source) => {
      if (source.status !== "captured") throw new Error("captured source expected");
      const left = psiV2CandidateFromLexicalEnvelope(
        "cand-a", lexicalIntervalSourceEnvelopes(source, "cand-a"), authority
      );
      const right = psiV2CandidateFromLexicalEnvelope(
        "cand-b", lexicalIntervalSourceEnvelopes(source, "cand-b"), authority
      );
      expect(left.coordinates[0]?.admission).not.toBeNull();
      expect(comparePsiV2(left, right, [authority]).kind).toBe("dominates");
    });
  });

  it("rejects empty, wrong-candidate, wrong-value, and wrong-provenance collapses", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-a", normalized_rank: 0.9 }],
      (authority) => {
        expectIssueBlocked(authority, collapse(authority, "cand-missing", 0.9));
        expectIssueBlocked(authority, collapse(authority, "cand-a", 0.8));
        expectIssueBlocked(authority, collapse(authority, "cand-a", 0.9, [{
          source_id: "lexical.interval.primary",
          producer: "caller.forged"
        }]));
      }
    );
    await withCapturedLexicalMeasurementAuthorityFixture(prepared, [], (authority) => {
      expectIssueBlocked(authority, collapse(authority, "cand-a", 0.9));
    });
  });

  it("invalidates authority and admissions after commit", async () => {
    const issued = await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-a", normalized_rank: 0.9 }],
      (authority) => {
        const measured = collapse(authority, "cand-a", 0.9);
        return { authority, measured, admission: issue(authority, measured) };
      }
    );
    expectIssueBlocked(issued.authority, issued.measured);
    expect(validateMeasurementAdmissionV1({
      admission: issued.admission,
      current_authorities: [issued.authority],
      contract: CONTRACT,
      proposition_schema: CONTRACT.proposition_schema,
      collapse: issued.measured
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
      [{ candidate_key: "cand-a", normalized_rank: 0.9 }],
      (current) => {
        authority = current;
        measured = collapse(current, "cand-a", 0.9);
        throw new Error("force rollback");
      },
      snapshot
    )).rejects.toThrow("force rollback");
    expectIssueBlocked(authority!, measured!);
  });

  it("binds admission to the exact authority object, not an equal digest", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "cand-a", normalized_rank: 0.9 }],
      async (first) => {
        const measured = collapse(first, "cand-a", 0.9);
        const admission = issue(first, measured);
        await withCapturedLexicalMeasurementAuthorityFixture(
          prepared,
          [{ candidate_key: "cand-a", normalized_rank: 0.9 }],
          (second) => {
            expect(second).not.toBe(first);
            expect(second.authority_digest).toBe(first.authority_digest);
            expect(validateMeasurementAdmissionV1({
              admission,
              current_authorities: [second],
              contract: CONTRACT,
              proposition_schema: CONTRACT.proposition_schema,
              collapse: measured
            }).status).toBe("blocked");
            expectIssueBlocked({ ...first } as VerifiedMeasurementAuthorityV1, measured);
            expect(validateMeasurementAdmissionV1({
              admission: { ...admission },
              current_authorities: [first],
              contract: CONTRACT,
              proposition_schema: CONTRACT.proposition_schema,
              collapse: measured
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
  provenance = PROVENANCE
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
  measured: MeasurementCollapseV1
) {
  if (measured.status !== "collapsed") throw new Error(measured.reason);
  return issueMeasurementGroupAdmission({
    authority,
    contract: CONTRACT,
    proposition_schema: CONTRACT.proposition_schema,
    collapse: measured
  });
}

function expectIssueBlocked(
  authority: VerifiedMeasurementAuthorityV1,
  measured: MeasurementCollapseV1
): void {
  expect(() => issue(authority, measured)).toThrow();
}
