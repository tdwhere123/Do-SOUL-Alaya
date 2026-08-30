import { describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import type { VerifiedMeasurementAuthorityV1 } from
  "../../../../recall/shadow/measurement/index.js";
import { psiV2CandidatesFromSupport } from
  "../../../../recall/shadow/psi-v2/index.js";
import type { SupportMaterializationV1 } from
  "../../../../recall/shadow/support/index.js";
import { createFourValuedWitness } from
  "../../../../recall/shadow/witness/index.js";

const QUERY_ID = `sha256:${"1".repeat(64)}`;
const SNAPSHOT_DIGEST = `sha256:${"2".repeat(64)}`;
const HYPOTHESIS_DIGEST = `sha256:${"3".repeat(64)}`;

describe("support proposition measurement authority", () => {
  it("keeps an observed proposition blocked while no source-owned authority exists", () => {
    const [candidate] = psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([proposition("left")])
    });
    expect(candidate?.coordinates).toHaveLength(1);
    expect(candidate?.coordinates[0]).toMatchObject({
      identity: null,
      admission: null,
      collapse: {
        status: "blocked",
        reason: "verified support measurement authority is unavailable"
      }
    });
  });

  it("does not accept a structurally matching support authority", () => {
    const counterfeit = Object.freeze({
      query_id: QUERY_ID,
      snapshot_digest: SNAPSHOT_DIGEST,
      request_digest: QUERY_ID,
      workspace_id: "workspace-1",
      field_prefix: null,
      candidate_key_domain: null,
      contract_digest: `sha256:${"4".repeat(64)}`,
      authority_digest: `sha256:${"5".repeat(64)}`
    }) as unknown as VerifiedMeasurementAuthorityV1;
    const [candidate] = psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([proposition("left")]),
      measurement_authority: counterfeit
    });
    expect(candidate?.coordinates[0]).toMatchObject({
      identity: null,
      admission: null,
      collapse: {
        status: "blocked",
        reason: expect.stringMatching(/admission unavailable.*not verified/u)
      }
    });
  });

  it("keeps producer absence, unavailability, and malformation distinct", () => {
    const outcomes: SupportMaterializationV1["outcomes"] = Object.freeze([
      Object.freeze({
        status: "not_observed" as const,
        owner: "left",
        source_owner: "path_projection" as const,
        reason: "receipt_absent" as const
      }),
      Object.freeze({
        status: "producer_unavailable" as const,
        owner: "left",
        source_owner: "temporal" as const,
        reason: "source_unavailable" as const
      }),
      Object.freeze({
        status: "malformed" as const,
        owner: "left",
        source_owner: "osf" as const,
        contract_code: "binding_identity_mismatch" as const
      })
    ]);
    const [candidate] = psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([], outcomes)
    });
    const reasons = candidate?.coordinates.map(({ collapse }) =>
      collapse.status === "blocked" ? collapse.reason : "") ?? [];
    expect(reasons).toEqual(expect.arrayContaining([
      "support producer not_observed: receipt_absent",
      "support producer producer_unavailable: source_unavailable",
      "support producer malformed: binding_identity_mismatch"
    ]));
  });

  it("keeps a missing hypothesis binding unresolved before authority", () => {
    const [candidate] = psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([proposition("left", null)])
    });
    expect(candidate?.coordinates[0]?.collapse).toMatchObject({
      status: "blocked",
      reason: "support proposition hypothesis binding is absent"
    });
  });

  it("canonicalizes support coordinates independent of observation order", () => {
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    expect(composed === decomposed).toBe(false);

    const forward = psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([
        proposition("left", HYPOTHESIS_DIGEST, composed),
        proposition("left", HYPOTHESIS_DIGEST, decomposed)
      ])
    });
    const reverse = psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([
        proposition("left", HYPOTHESIS_DIGEST, decomposed),
        proposition("left", HYPOTHESIS_DIGEST, composed)
      ])
    });
    const forwardIds = forward[0]?.coordinates.map((row) => row.proposition_id);
    expect(forwardIds).toEqual(
      reverse[0]?.coordinates.map((row) => row.proposition_id)
    );
    expect(forwardIds).toEqual([...(forwardIds ?? [])].sort());
  });
});

function proposition(
  candidateId: string,
  hypothesisDigest: string | null = HYPOTHESIS_DIGEST,
  localPropositionId = "prop-local"
) {
  return Object.freeze({
    candidate_id: candidateId,
    local_proposition_id: localPropositionId,
    hypothesis_digest: hypothesisDigest,
    witness: createFourValuedWitness({
      identity: {
        coordinate_id: `raw:${candidateId}:${localPropositionId}`,
        query_id: QUERY_ID,
        snapshot_digest: SNAPSHOT_DIGEST,
        candidate_id: candidateId,
        proposition_id: localPropositionId
      },
      provenance: [{ source_id: `lineage:${candidateId}`, producer: "support.test" }],
      epistemic: { kind: "exact" },
      payload: { polarity: "supported_only" }
    })
  });
}

function support(
  propositionObservations: readonly ReturnType<typeof proposition>[],
  outcomes: SupportMaterializationV1["outcomes"] = []
): SupportMaterializationV1 {
  const graphBody = {
    schema_version: 1 as const,
    operator_id: "recall_support_hypergraph_v1" as const,
    query_id: QUERY_ID,
    snapshot_digest: SNAPSHOT_DIGEST,
    nodes: [],
    edges: [],
    aliases: [],
    correlations: []
  };
  return Object.freeze({
    graph: Object.freeze({
      ...graphBody,
      digest: digestRecallFieldIdentity(graphBody)
    }),
    polarities: Object.freeze([]),
    proposition_observations: Object.freeze([...propositionObservations]),
    gaps: Object.freeze([]),
    outcomes: Object.freeze([...outcomes])
  });
}
