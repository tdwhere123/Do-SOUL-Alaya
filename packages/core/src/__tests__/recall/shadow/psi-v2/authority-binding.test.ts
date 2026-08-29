import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import type { VerifiedMeasurementAuthorityV1 } from
  "../../../../recall/shadow/measurement/index.js";
import type { LexicalIntervalSourceReceiptCapturedV1 } from
  "../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../recall/shadow/measurement/lexical-interval-envelope.js";
import {
  comparePsiV2,
  psiV2CandidateFromLexicalEnvelope,
  type PsiV2CandidateV1
} from "../../../../recall/shadow/psi-v2/index.js";
import {
  measurementEvidenceWithAlternateCompilation,
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture,
  withCapturedLexicalMeasurementAuthorityFixture
} from "../measurement/prepared-authority-fixture.js";

let prepared: PreparedRecallRequest;

describe("Psi v2 authority binding", () => {
  beforeAll(async () => {
    prepared = await prepareMeasurementEvidenceFixture();
  });

  afterAll(() => releaseMeasurementEvidenceFixture(prepared));

  it("blocks cross-compilation and prior-request reuse but permits current pairs", async () => {
    await withCapturedLexicalMeasurementAuthorityFixture(
      prepared,
      [{ candidate_key: "prior-left", normalized_rank: 0.9 },
        { candidate_key: "prior-right", normalized_rank: 0.1 }],
      async (originalAuthority, originalSource) => {
        requireCaptured(originalSource);
        const priorLeft = candidate("prior-left", originalAuthority, originalSource);
        const priorRight = candidate("prior-right", originalAuthority, originalSource);
        await withCapturedLexicalMeasurementAuthorityFixture(
          prepared,
          [{ candidate_key: "current-left", normalized_rank: 0.9 },
            { candidate_key: "current-right", normalized_rank: 0.1 }],
          (currentAuthority, currentSource) => {
            requireCaptured(currentSource);
            expect(currentAuthority.authority_digest)
              .not.toBe(originalAuthority.authority_digest);
            const currentLeft = candidate("current-left", currentAuthority, currentSource);
            const currentRight = candidate("current-right", currentAuthority, currentSource);
            expect(comparePsiV2(priorLeft, currentRight, [currentAuthority]).kind)
              .toBe("blocked");
            expect(comparePsiV2(priorLeft, priorRight, [currentAuthority]).kind)
              .toBe("blocked");
            expect(comparePsiV2(currentLeft, currentRight, [currentAuthority]).kind)
              .toBe("dominates");
            expect(comparePsiV2(
              currentLeft, currentRight, [currentAuthority, currentAuthority]
            ).kind).toBe("blocked");
            expect(comparePsiV2(
              currentLeft, currentRight, [originalAuthority, currentAuthority]
            ).kind).toBe("blocked");
            expect(comparePsiV2(currentLeft, currentRight, [
              currentAuthority,
              { ...currentAuthority } as VerifiedMeasurementAuthorityV1
            ]).kind).toBe("blocked");
          },
          undefined,
          measurementEvidenceWithAlternateCompilation(prepared, true)
        );
      }
    );
  });

  it("blocks coordinates admitted under a different query lease", async () => {
    const later = await prepareMeasurementEvidenceFixture("2026-08-29T00:00:01.000Z");
    try {
      await withCapturedLexicalMeasurementAuthorityFixture(
        prepared,
        [{ candidate_key: "prior", normalized_rank: 0.9 }],
        async (originalAuthority, originalSource) => {
          requireCaptured(originalSource);
          const prior = candidate("prior", originalAuthority, originalSource);
          await withCapturedLexicalMeasurementAuthorityFixture(
            later,
            [{ candidate_key: "later", normalized_rank: 0.1 }],
            (laterAuthority, laterSource) => {
              requireCaptured(laterSource);
              expect(laterAuthority.authority_digest)
                .not.toBe(originalAuthority.authority_digest);
              expect(laterAuthority.snapshot_digest)
                .not.toBe(originalAuthority.snapshot_digest);
              expect(comparePsiV2(
                prior,
                candidate("later", laterAuthority, laterSource),
                [laterAuthority]
              ).kind).toBe("blocked");
            }
          );
        }
      );
    } finally {
      releaseMeasurementEvidenceFixture(later);
    }
  });
});

function candidate(
  candidateId: string,
  authority: VerifiedMeasurementAuthorityV1,
  source: LexicalIntervalSourceReceiptCapturedV1
): PsiV2CandidateV1 {
  const key = `workspace_local:memory_entry:${candidateId}`;
  return psiV2CandidateFromLexicalEnvelope(
    key,
    lexicalIntervalSourceEnvelopes(source, key),
    authority
  );
}

function requireCaptured(
  source: Parameters<Parameters<typeof withCapturedLexicalMeasurementAuthorityFixture>[2]>[1]
): asserts source is LexicalIntervalSourceReceiptCapturedV1 {
  if (source.status !== "captured") throw new Error("captured source expected");
}
