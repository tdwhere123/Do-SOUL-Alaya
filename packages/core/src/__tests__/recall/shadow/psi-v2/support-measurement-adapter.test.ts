import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import {
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  verifyMeasurementPreparedAuthorityV1,
  type VerifiedMeasurementAuthorityV1
} from "../../../../recall/shadow/measurement/index.js";
import {
  buildPsiV2ShadowDiagnostics,
  comparePsiV2 as comparePsiV2WithAuthorities,
  psiV2CandidatesFromSupport
} from "../../../../recall/shadow/psi-v2/index.js";
import type { SupportMaterializationV1 } from
  "../../../../recall/shadow/support/index.js";
import { createFourValuedWitness, type FourValuedPolarity } from
  "../../../../recall/shadow/witness/index.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import { buildDefaultPolicy } from
  "../../../../recall/runtime/orchestration.js";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { createDependencies, createTaskSurface } from
  "../../recall-service-test-fixtures.js";

const NOW = "2026-08-29T00:00:00.000Z";
const HYPOTHESIS_A = `sha256:${"1".repeat(64)}`;
const HYPOTHESIS_B = `sha256:${"2".repeat(64)}`;
let prepared: PreparedRecallRequest;
let authority: VerifiedMeasurementAuthorityV1;
const comparePsiV2 = (
  left: Parameters<typeof comparePsiV2WithAuthorities>[0],
  right: Parameters<typeof comparePsiV2WithAuthorities>[1]
) => comparePsiV2WithAuthorities(left, right, [authority]);

describe("support proposition measurement adapter", () => {
  beforeAll(async () => {
    prepared = await prepareAuthority();
    authority = verifyMeasurementPreparedAuthorityV1({
      evidence: {
        workspace_id: "workspace-1",
        query_condition: prepared.queryCondition,
        canonical_query_evidence: prepared.canonicalQueryEvidence,
        canonical_query_compilation: prepared.canonicalQueryCompilation,
        snapshot_vector: prepared.snapshotVector,
        snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
        snapshot_read_lease: prepared.snapshotReadLease
      },
      contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT
    });
  });

  afterAll(() => {
    prepared.releaseProjectionPin();
    prepared.projectionPinLease.stop();
  });

  it.each([
    ["supported_only", "refuted_only", "incomparable"],
    ["supported_only", "supported_only", "equal"],
    ["refuted_only", "refuted_only", "equal"],
    ["both", "supported_only", "blocked"],
    ["unknown", "supported_only", "blocked"]
  ] as const)("compares %s and %s as %s", (left, right, expected) => {
    const candidates = psiV2CandidatesFromSupport({
      candidate_keys: ["left", "right"],
      support: support([
        proposition("left", HYPOTHESIS_A, left),
        proposition("right", HYPOTHESIS_A, right)
      ]),
      measurement_authority: authority
    });
    expect(comparePsiV2(candidates[0]!, candidates[1]!)).toMatchObject({ kind: expected });
  });

  it("dedupes duplicate lineage observations and isolates local ids across hypotheses", () => {
    const duplicate = proposition("left", HYPOTHESIS_A, "supported_only");
    const candidates = psiV2CandidatesFromSupport({
      candidate_keys: ["left", "right"],
      support: support([
        duplicate,
        duplicate,
        proposition("right", HYPOTHESIS_B, "supported_only")
      ]),
      measurement_authority: authority
    });
    expect(candidates[0]?.coordinates).toHaveLength(1);
    expect(candidates[0]?.coordinates[0]?.proposition_id)
      .not.toBe(candidates[1]?.coordinates[0]?.proposition_id);
    expect(comparePsiV2(candidates[0]!, candidates[1]!).kind).toBe("blocked");
  });

  it("keeps absent, unavailable, and malformed producer outcomes as distinct blockers", () => {
    const variants = [
      {
        status: "not_observed" as const,
        owner: "left",
        source_owner: "path_projection",
        reason: "receipt_absent" as const
      },
      {
        status: "producer_unavailable" as const,
        owner: "left",
        source_owner: "path_relations",
        reason: "source_view_unavailable" as const
      },
      {
        status: "malformed" as const,
        owner: "left",
        source_owner: "path_relations",
        contract_code: "receipt_digest_mismatch" as const
      }
    ];
    const rows = variants.map((outcome) => psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([], [outcome]),
      measurement_authority: authority
    })[0]!);
    expect(rows.map((row) => row.coordinates[0]?.collapse.status))
      .toEqual(["blocked", "blocked", "blocked"]);
    expect(new Set(rows.map((row) => row.coordinates[0]?.collapse.status === "blocked"
      ? row.coordinates[0].collapse.reason
      : ""))).toHaveLength(3);
  });

  it("blocks missing or malformed hypothesis binding and prepared identity mismatch", () => {
    const unbound = proposition("left", null, "supported_only");
    const queryMismatch = proposition("right", HYPOTHESIS_A, "supported_only", {
      query_id: "other-query"
    });
    const malformed = proposition("third", "not-a-digest", "supported_only");
    const rows = psiV2CandidatesFromSupport({
      candidate_keys: ["left", "right", "third"],
      support: support([unbound, queryMismatch, malformed]),
      measurement_authority: authority
    });
    expect(rows[0]?.coordinates[0]?.collapse).toMatchObject({
      status: "blocked",
      reason: "support proposition hypothesis binding is absent"
    });
    expect(rows[1]?.coordinates[0]?.collapse).toMatchObject({
      status: "blocked",
      reason: "support proposition query or snapshot binding mismatch"
    });
    expect(rows[2]?.coordinates[0]?.collapse).toMatchObject({
      status: "blocked",
      reason: "support proposition hypothesis binding is malformed"
    });
  });

  it("runs support-only candidates through pair and frontier diagnostics", () => {
    const materialization = support([
      proposition("left", HYPOTHESIS_A, "supported_only"),
      proposition("right", HYPOTHESIS_A, "refuted_only")
    ]);
    const diagnostics = buildPsiV2ShadowDiagnostics({
      query_id: authority.query_id,
      snapshot_digest: authority.snapshot_digest,
      candidate_keys: ["left", "right"],
      support: materialization,
      support_measurement_authority: authority
    });
    expect(diagnostics).toMatchObject({
      observation_status: "observed",
      blocked_share: 0,
      incomparable_share: 1,
      tradeoff_share: 0,
      equal_share: 0,
      cycle_count: 0,
      support_graph_digest: materialization.graph.digest
    });
    expect(diagnostics.frontier_width).toBe(1);
    expect(diagnostics.undominated_share).toBe(1);
  });

  it("serializes absent, unavailable, and malformed outcomes into distinct status bytes", () => {
    const variants = [
      {
        status: "not_observed" as const,
        owner: "left",
        source_owner: "path_projection",
        reason: "receipt_absent" as const
      },
      {
        status: "producer_unavailable" as const,
        owner: "left",
        source_owner: "path_relations",
        reason: "source_view_unavailable" as const
      },
      {
        status: "malformed" as const,
        owner: "left",
        source_owner: "path_relations",
        contract_code: "receipt_digest_mismatch" as const
      }
    ];
    const diagnostics = variants.map((outcome) => buildPsiV2ShadowDiagnostics({
      query_id: authority.query_id,
      snapshot_digest: authority.snapshot_digest,
      candidate_keys: ["left", "right"],
      support: support([], [outcome]),
      support_measurement_authority: authority
    }));
    expect(diagnostics.map((row) => row.observation_status))
      .toEqual(["not_observed", "producer_unavailable", "malformed"]);
    expect(new Set(diagnostics.map((row) => row.support_outcome_digest))).toHaveLength(3);
    expect(new Set(diagnostics.map((row) => row.digest))).toHaveLength(3);
    expect(diagnostics.every((row) => row.blocked_share === 1)).toBe(true);
    expect(diagnostics[0]?.reasons).toContain(
      "support producer not_observed: receipt_absent");
    expect(diagnostics[1]?.reasons).toContain(
      "support producer producer_unavailable: source_view_unavailable");
    expect(diagnostics[2]?.reasons).toContain(
      "support producer malformed: receipt_digest_mismatch");
  });

  it("keeps lexical absence, unavailability, and malformation visible beside support observations", () => {
    const lexicalOutcomes = [
      { producer_id: "lex.interval", status: "not_observed", reason: "input_absent" },
      { producer_id: "lex.interval", status: "producer_unavailable", reason: "authority_unavailable" },
      { producer_id: "lex.interval", status: "malformed",
        contract_code: "authority_identity_mismatch" }
    ] as const;
    const diagnostics = lexicalOutcomes.map((lexicalOutcome) =>
      buildPsiV2ShadowDiagnostics({
        query_id: authority.query_id,
        snapshot_digest: authority.snapshot_digest,
        candidate_keys: ["left"],
        support: support([proposition("left", HYPOTHESIS_A, "supported_only")]),
        support_measurement_authority: authority,
        producer_outcomes: [
          lexicalOutcome,
          { producer_id: "support", status: "observed" }
        ]
      }));
    expect(diagnostics.map((row) => row.observation_status))
      .toEqual(["observed", "producer_unavailable", "malformed"]);
    expect(diagnostics.map((row) => row.producer_outcomes[0])).toEqual(lexicalOutcomes);
    expect(new Set(diagnostics.map((row) => JSON.stringify(row.producer_outcomes))).size).toBe(3);
    expect(new Set(diagnostics.map((row) => row.digest)).size).toBe(3);
    expect(diagnostics.every((row) => row.frontier_width > 0)).toBe(true);
  });

  it("does not turn unknown correlation into proposition strength", () => {
    const observations = [
      proposition("left", HYPOTHESIS_A, "supported_only"),
      proposition("right", HYPOTHESIS_A, "supported_only")
    ];
    const baseline = buildPsiV2ShadowDiagnostics({
      query_id: authority.query_id,
      snapshot_digest: authority.snapshot_digest,
      candidate_keys: ["left", "right"],
      support: support(observations),
      support_measurement_authority: authority
    });
    const unknownCorrelation = buildPsiV2ShadowDiagnostics({
      query_id: authority.query_id,
      snapshot_digest: authority.snapshot_digest,
      candidate_keys: ["left", "right"],
      support: support(observations, [], [{
        left_id: "evidence-a",
        right_id: "evidence-b",
        state: "possibly_correlated"
      }]),
      support_measurement_authority: authority
    });
    expect({
      frontier_width: unknownCorrelation.frontier_width,
      blocked_share: unknownCorrelation.blocked_share,
      incomparable_share: unknownCorrelation.incomparable_share,
      tradeoff_share: unknownCorrelation.tradeoff_share,
      equal_share: unknownCorrelation.equal_share
    }).toEqual({
      frontier_width: baseline.frontier_width,
      blocked_share: baseline.blocked_share,
      incomparable_share: baseline.incomparable_share,
      tradeoff_share: baseline.tradeoff_share,
      equal_share: baseline.equal_share
    });
    expect(unknownCorrelation.visibility?.unknown_correlation).toBe(true);
  });

  it("keeps a missing proposition pin as binding_absent and unresolved", () => {
    const candidates = psiV2CandidatesFromSupport({
      candidate_keys: ["left"],
      support: support([], [], [], [{
        kind: "binding_absent",
        owner: "left",
        detail: "query proposition pin is absent"
      }]),
      measurement_authority: authority
    });
    expect(candidates[0]?.coordinates[0]?.collapse).toMatchObject({
      status: "blocked",
      reason: "support binding unresolved: query proposition pin is absent"
    });
  });
});

function proposition(
  candidateId: string,
  hypothesisDigest: string | null,
  polarity: FourValuedPolarity,
  pins: Partial<{ readonly query_id: string; readonly snapshot_digest: string }> = {}
) {
  return Object.freeze({
    candidate_id: candidateId,
    local_proposition_id: "prop-local",
    hypothesis_digest: hypothesisDigest,
    witness: createFourValuedWitness({
      identity: {
        coordinate_id: `raw:${candidateId}:prop-local`,
        query_id: pins.query_id ?? authority.query_id,
        snapshot_digest: pins.snapshot_digest ?? authority.snapshot_digest,
        candidate_id: candidateId,
        proposition_id: "prop-local"
      },
      provenance: [{ source_id: `lineage:${candidateId}`, producer: "support.test" }],
      epistemic: polarity === "both" ? { kind: "conflict" } : { kind: "exact" },
      payload: { polarity }
    })
  });
}

function support(
  propositionObservations: readonly ReturnType<typeof proposition>[],
  outcomes: SupportMaterializationV1["outcomes"] = [],
  correlations: SupportMaterializationV1["graph"]["correlations"] = [],
  gaps: SupportMaterializationV1["gaps"] = []
): SupportMaterializationV1 {
  const graphBody = {
    schema_version: 1 as const,
    operator_id: "recall_support_hypergraph_v1" as const,
    query_id: authority.query_id,
    snapshot_digest: authority.snapshot_digest,
    nodes: [],
    edges: [],
    aliases: [],
    correlations
  };
  return Object.freeze({
    graph: Object.freeze({
      ...graphBody,
      digest: digestRecallFieldIdentity(graphBody)
    }),
    polarities: Object.freeze([]),
    proposition_observations: Object.freeze([...propositionObservations]),
    gaps: Object.freeze([...gaps]),
    outcomes: Object.freeze([...outcomes])
  });
}

async function prepareAuthority(): Promise<PreparedRecallRequest> {
  const { dependencies } = createDependencies([]);
  return await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => NOW,
    buildDefaultPolicy: () => buildDefaultPolicy({
      strategy: "build",
      taskSurfaceRef: "task-surface-1",
      now: () => NOW,
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    }),
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256,
      "workspace-1"
    ),
    sha256: fieldContractSha256
  }, {
    taskSurface: createTaskSurface(),
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, captureRecallRequestTime({ now: () => NOW }));
}
