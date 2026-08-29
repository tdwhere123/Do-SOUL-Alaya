import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import {
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  collapseMeasurementGroup,
  issueMeasurementGroupAdmission,
  type VerifiedMeasurementAuthorityV1
} from "../../../../recall/shadow/measurement/index.js";
import type { LexDomain } from "../../../../recall/shadow/observations.js";
import {
  comparePsiV2,
  type PsiV2CandidateV1
} from "../../../../recall/shadow/psi-v2/index.js";
import { createNumericIntervalWitness } from
  "../../../../recall/shadow/witness/index.js";
import { PINS, PROV } from "../witness/fixtures.js";
import {
  measurementEvidenceWithAlternateCompilation,
  prepareLexicalMeasurementAuthorityFixture,
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture
} from "../measurement/prepared-authority-fixture.js";

const CONTRACT = LEXICAL_INTERVAL_MEASUREMENT_CONTRACT;
const DOMAIN: LexDomain = Object.freeze({
  lane_id: "exact",
  list_n: 8,
  status: "complete",
  raw_key_kind: "matched_token_count"
});
let prepared: PreparedRecallRequest;
let originalAuthority: VerifiedMeasurementAuthorityV1;

describe("Psi v2 authority binding", () => {
  beforeAll(async () => {
    prepared = await prepareMeasurementEvidenceFixture();
    originalAuthority = await verifiedAuthority(prepared);
  });

  afterAll(() => releaseMeasurementEvidenceFixture(prepared));

  it("blocks cross-compilation and prior-request reuse but permits current pairs", async () => {
    const currentAuthority = await prepareLexicalMeasurementAuthorityFixture(
      prepared,
      measurementEvidenceWithAlternateCompilation(prepared, true)
    );
    expect(currentAuthority.authority_digest).not.toBe(originalAuthority.authority_digest);
    expect({
      query_id: currentAuthority.query_id,
      snapshot_digest: currentAuthority.snapshot_digest,
      request_digest: currentAuthority.request_digest,
      workspace_id: currentAuthority.workspace_id,
      contract_digest: currentAuthority.contract_digest
    }).toEqual({
      query_id: originalAuthority.query_id,
      snapshot_digest: originalAuthority.snapshot_digest,
      request_digest: originalAuthority.request_digest,
      workspace_id: originalAuthority.workspace_id,
      contract_digest: originalAuthority.contract_digest
    });
    const priorLeft = candidate("prior-left", 9, originalAuthority);
    const priorRight = candidate("prior-right", 1, originalAuthority);
    const currentLeft = candidate("current-left", 9, currentAuthority);
    const currentRight = candidate("current-right", 1, currentAuthority);

    expect(comparePsiV2(priorLeft, currentRight, [currentAuthority]).kind).toBe("blocked");
    expect(comparePsiV2(priorLeft, priorRight, [currentAuthority]).kind).toBe("blocked");
    expect(comparePsiV2(currentLeft, currentRight, [currentAuthority]).kind)
      .toBe("dominates");
  });

  it("blocks coordinates admitted under a different query lease", async () => {
    const later = await prepareMeasurementEvidenceFixture("2026-08-29T00:00:01.000Z");
    try {
      const laterAuthority = await verifiedAuthority(later);
      expect(laterAuthority.authority_digest).not.toBe(originalAuthority.authority_digest);
      expect(laterAuthority.snapshot_digest).not.toBe(originalAuthority.snapshot_digest);
      expect(comparePsiV2(
        candidate("prior", 9, originalAuthority),
        candidate("later", 1, laterAuthority),
        [laterAuthority]
      ).kind).toBe("blocked");
    } finally {
      releaseMeasurementEvidenceFixture(later);
    }
  });
});

function verifiedAuthority(preparedRequest: PreparedRecallRequest) {
  return prepareLexicalMeasurementAuthorityFixture(preparedRequest);
}

function candidate(
  candidateId: string,
  value: number,
  authority: VerifiedMeasurementAuthorityV1
): PsiV2CandidateV1 {
  const collapse = collapseMeasurementGroup({
    contract: CONTRACT,
    observations: [createNumericIntervalWitness({
      identity: {
        ...PINS,
        coordinate_id: `${candidateId}:p`,
        query_id: authority.query_id,
        snapshot_digest: authority.snapshot_digest,
        candidate_id: candidateId,
        proposition_id: "p"
      },
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { lower: value, upper: value }
    })]
  });
  if (collapse.status !== "collapsed") throw new Error(collapse.reason);
  const admission = issueMeasurementGroupAdmission({
    authority,
    contract: CONTRACT,
    proposition_schema: CONTRACT.proposition_schema,
    collapse
  });
  return Object.freeze({
    candidate_id: candidateId,
    coordinates: Object.freeze([Object.freeze({
      proposition_id: "p",
      proposition_schema: CONTRACT.proposition_schema,
      identity: admission,
      collapse,
      admission,
      applicable: true,
      lex_domain: DOMAIN,
      envelope_identity: Object.freeze({
        field_prefix: "lexical_relaxed",
        query_run_id: authority.query_id,
        snapshot_digest: authority.snapshot_digest,
        request_digest: authority.request_digest as `sha256:${string}`,
        workspace_id: authority.workspace_id
      })
    })])
  });
}
