import { describe, expect, it } from "vitest";
import { materializeSupportFromReceipts } from
  "../../../../recall/shadow/support/index.js";
import {
  createSnapshotCoherenceReceiptV1,
  createSnapshotVectorV1,
  type SourceFrontierDeclarationV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { QUERY, SNAPSHOT } from "./fixtures.js";

const CAND = "workspace_local:memory_entry:cand-1";
const CAND_B = "workspace_local:memory_entry:cand-2";
const AS_OF = "2026-08-29T00:00:00.000Z";
const TX_FRONTIER = "tx-frontier-1";
const RELATIONAL_SCOPE = "recall.relational";
const AUTHORITY_CONTEXT = createAuthorityContext();
const RELATIONAL_SNAPSHOT = AUTHORITY_CONTEXT.snapshot_vector.vector_digest;

describe("support receipt adapters", () => {
  it("materializes OSF bindings, fact frames, polarity, and evidence lineage", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at",
            source_lineage_id: "lineage-a"
          }]
        },
        fact_frames: [{ semantic_identity: "person.alice", role: "entity", evidence_id: "eu-1" }],
        polarity: {
          status: "available",
          value: {
            polarity: "positive",
            lineage_id: "lineage-a",
            proposition_id: "prop.works-at",
            receipt: polarityReceipt("lineage-a")
          }
        },
        evidence_ids: ["eu-1"],
        f3_present: true
      }]
    });
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding" && node.id === "person.alice")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "supports")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "sourced_from")).toBe(true);
    expect(result.polarities[0]?.payload?.polarity).toBe("supported_only");
  });

  it("does not mint a proposition from a binding lemma when query_proposition_id is absent", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1"
          }]
        }
      }]
    });
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding" && node.id === "person.alice")).toBe(true);
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.graph.nodes.some((node) => node.id === "person.alice" && node.kind === "proposition")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(false);
    expect(result.gaps.some((gap) => gap.kind === "binding_absent")).toBe(true);
  });

  it("does not vote supports or supported_only from OSF formation alone", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: "prop.works-at",
            source_lineage_id: "lineage-a"
          }]
        }
      }]
    });
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "yields")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.kind === "supports")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "refutes")).toBe(false);
    expect(result.polarities).toEqual([]);
  });

  it("records ineligible and rejected OSF as gaps, not empty bindings", () => {
    const ineligible = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "ineligible",
          truncated: false,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-trap",
            query_proposition_id: "prop.trap"
          }]
        }
      }]
    });
    expect(ineligible.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(ineligible.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(ineligible.gaps.some((gap) => gap.kind === "osf_ineligible")).toBe(true);

    const rejected = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: { composition_status: "rejected", truncated: false, bindings: [] }
      }]
    });
    expect(rejected.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(rejected.gaps.some((gap) => gap.kind === "osf_rejected")).toBe(true);
  });

  it("emits supersedes from a bound proposition pair and leaves bare standing open", () => {
    const paired = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [{
        candidate_key: CAND,
        supersession: {
          status: "available",
          value: {
            standing: "superseded",
            lineage_id: "lineage-old",
            proposition_id: "prop.old",
            counterpart_proposition_id: "prop.new",
            receipt: supersessionReceipt("lineage-old", "prop.old", "prop.new")
          }
        }
      }]
    });
    expect(paired.graph.edges.some((edge) =>
      edge.kind === "supersedes"
      && edge.from.id === "prop.new"
      && edge.to.id === "prop.old"
    )).toBe(true);
    expect(paired.gaps.some((gap) => gap.kind === "supersedes_open")).toBe(false);

    const open = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        supersession: {
          status: "available",
          value: {
            standing: "superseded",
            lineage_id: "lineage-old",
            proposition_id: "prop.old"
          }
        }
      }]
    });
    expect(open.graph.edges.some((edge) => edge.kind === "supersedes")).toBe(false);
    expect(open.graph.nodes.filter((node) => node.kind === "proposition").map((node) => node.id))
      .toEqual([]);
    expect(open.gaps.some((gap) => gap.kind === "authority_untrusted")).toBe(true);
  });

  it("keeps bare standing conflicted and resolves only with a fully bound receipt", () => {
    const both = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive", polarityReceipt("lineage-a")),
        polarityCandidate(CAND_B, "lineage-b", "negative", polarityReceipt("lineage-b"))
      ]
    });
    expect(both.polarities[0]?.payload?.polarity).toBe("both");
    expect(both.polarities[0]?.epistemic.kind).toBe("conflict");

    const resolved = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive", polarityReceipt("lineage-a")),
        {
          ...polarityCandidate(CAND_B, "lineage-b", "negative", polarityReceipt("lineage-b")),
          supersession: {
            status: "available",
            value: {
              standing: "superseded",
              lineage_id: "lineage-b",
              proposition_id: "prop.works-at",
              receipt: supersessionReceipt("lineage-b", "prop.works-at")
            }
          }
        }
      ]
    });
    expect(resolved.polarities[0]?.payload?.polarity).toBe("supported_only");

    const bareStanding = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive", polarityReceipt("lineage-a")),
        {
          ...polarityCandidate(CAND_B, "lineage-b", "negative", polarityReceipt("lineage-b")),
          supersession: {
            status: "available",
            value: {
              standing: "superseded",
              lineage_id: "lineage-b",
              proposition_id: "prop.works-at"
            }
          }
        }
      ]
    });
    expect(bareStanding.polarities[0]?.payload?.polarity).toBe("both");
    expect(bareStanding.gaps.some((gap) => gap.kind === "authority_untrusted")).toBe(true);
  });

  it.each([
    ["unknown", { kind: "unknown" as const }],
    ["inactive", {
      kind: "bounded" as const,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-29T00:00:00.000Z"
    }]
  ])("does not admit proposition or grounds from a %s-time path", (_label, valid_time) => {
    const result = pathMaterialization({}, pathReceipt({ valid_time }));
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(false);
    expect(result.gaps.some((gap) =>
      gap.kind === "time_unknown" || gap.kind === "time_not_active"
    )).toBe(true);
  });

  it.each([
    ["query", pathReceipt({ query_id: "wrong-query" })],
    ["snapshot", pathReceipt({ snapshot_digest: `sha256:${"d".repeat(64)}` })],
    ["transaction", pathReceipt({ transaction_frontier: "tx-frontier-wrong" })],
    ["authority", pathReceipt({ authorized_scope: "recall.untrusted" })]
  ])("does not let wrong %s binding admit relational truth", (_label, receipt) => {
    const result = pathMaterialization({}, receipt);
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.graph.edges.some((edge) => edge.kind === "grounds")).toBe(false);
    expect(result.gaps.some((gap) =>
      gap.kind === "relational_identity_mismatch"
      || gap.kind === "transaction_unfrozen"
      || gap.kind === "authority_untrusted"
    )).toBe(true);
  });

  it("treats truncated or unavailable OSF as unknown, not an empty binding set", () => {
    const truncated = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: {
          composition_status: "composed",
          truncated: true,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-trap"
          }]
        }
      }]
    });
    expect(truncated.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(truncated.gaps.some((gap) => gap.kind === "osf_truncated")).toBe(true);

    const unavailable = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: { composition_status: "unavailable", truncated: false, bindings: [] }
      }]
    });
    expect(unavailable.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(unavailable.gaps.some((gap) => gap.kind === "osf_unavailable")).toBe(true);

    const noMatch = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        osf: { composition_status: "no_match", truncated: false, bindings: [] }
      }]
    });
    expect(noMatch.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(noMatch.gaps.some((gap) => gap.kind === "osf_no_match")).toBe(true);
  });

  it("keeps F0-F2 evidence when F3 is absent and does not mint bindings from answer-support hashes", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        evidence_ids: ["eu-root", "eu-f0"],
        f3_present: false,
        answer_support: { status: "compatible", eligible: true, evidence_ref: "eu-root" }
      }]
    });
    const units = result.graph.nodes.filter((node) => node.kind === "evidence_unit").map((node) => node.id);
    expect(units.sort()).toEqual(["eu-f0", "eu-root"]);
    expect(result.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(result.gaps.some((gap) => gap.kind === "f3_absent")).toBe(true);
  });

  it("records unknown time as a gap and ignores path energy/hop/duplicates", () => {
    const unknownTime = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        temporal: { event_time: null, time_status: "unknown" }
      }]
    });
    expect(unknownTime.gaps.some((gap) => gap.kind === "time_unknown")).toBe(true);

    const withEnergy = pathMaterialization({ strength: 9, hop: 4, path_count: 8 });
    const withoutEnergy = pathMaterialization({});
    expect(withEnergy.graph.digest).toBe(withoutEnergy.graph.digest);
    expect(withEnergy.polarities).toEqual(withoutEnergy.polarities);
    expect(withEnergy.graph.nodes.filter((node) => node.kind === "evidence_unit")).toHaveLength(1);
  });
});

function polarityCandidate(
  candidateKey: string,
  lineageId: string,
  polarity: "positive" | "negative",
  receipt?: ReturnType<typeof relationalReceipt>
) {
  return {
    candidate_key: candidateKey,
    polarity: {
      status: "available" as const,
      value: {
        polarity,
        lineage_id: lineageId,
        proposition_id: "prop.works-at",
        ...(receipt === undefined ? {} : { receipt })
      }
    },
    evidence_ids: [`eu-${lineageId}`],
    contradiction: polarity === "negative"
      ? {
        status: "available" as const,
        value: {
          standing: "contradicting" as const,
          lineage_id: lineageId,
          proposition_id: "prop.works-at",
          ...(receipt === undefined ? {} : { receipt: contradictionReceipt(lineageId) })
        }
      }
      : undefined
  };
}

function pathMaterialization(
  extras: { strength?: number; hop?: number; path_count?: number },
  receipt = pathReceipt()
) {
  return materializeSupportFromReceipts({
    query_id: QUERY,
    snapshot_digest: RELATIONAL_SNAPSHOT,
    authority_context: authorityContext(),
    candidates: [{
      candidate_key: CAND,
      path: {
        evidence_basis: ["eu-path", "eu-path"],
        relation_kind: "works_at",
        proposition_id: "prop.works-at",
        receipt,
        ...extras
      }
    }]
  });
}

function authorityContext() {
  return AUTHORITY_CONTEXT;
}

function relationalReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1 as const,
    query_id: QUERY,
    snapshot_digest: RELATIONAL_SNAPSHOT,
    snapshot_receipt_digest: AUTHORITY_CONTEXT.snapshot_receipt.receipt_digest,
    effective_as_of: AS_OF,
    transaction_frontier: TX_FRONTIER,
    producer_operator_id: "relation_assertion_projection_v1",
    authorized_scope: RELATIONAL_SCOPE,
    valid_time: { kind: "open" as const, from: "2026-08-01T00:00:00.000Z" },
    ...overrides
  };
}

function pathReceipt(overrides: Record<string, unknown> = {}) {
  return relationalReceipt({
    subject: {
      kind: "path_projection" as const,
      proposition_id: "prop.works-at",
      relation_kind: "works_at"
    },
    ...overrides
  });
}

function polarityReceipt(lineage_id: string) {
  return relationalReceipt({
    subject: { kind: "polarity" as const, proposition_id: "prop.works-at", lineage_id }
  });
}

function contradictionReceipt(lineage_id: string) {
  return relationalReceipt({
    subject: { kind: "contradiction" as const, proposition_id: "prop.works-at", lineage_id }
  });
}

function supersessionReceipt(
  lineage_id: string,
  proposition_id: string,
  counterpart_proposition_id?: string
) {
  return relationalReceipt({
    subject: {
      kind: "supersession" as const,
      proposition_id,
      lineage_id,
      ...(counterpart_proposition_id === undefined ? {} : { counterpart_proposition_id })
    }
  });
}

function createAuthorityContext() {
  const declaration = (source_owner: string): SourceFrontierDeclarationV1 => ({
    source_owner,
    principal: "principal-1",
    authorized_scope: RELATIONAL_SCOPE,
    source_frontier: TX_FRONTIER,
    valid_time_domain: { kind: "open", from: "2026-08-01T00:00:00.000Z" },
    generation: "generation-1",
    operator_or_model_version: "operator-1",
    lag_bound: { kind: "exact" }
  });
  const snapshot_vector = createSnapshotVectorV1({
    principal: "principal-1",
    authorized_scopes: [RELATIONAL_SCOPE],
    effective_as_of: AS_OF,
    transaction_frontier: TX_FRONTIER,
    base_store_digest: `sha256:${"a".repeat(64)}`,
    projection_generation: declaration("projection_generation"),
    retrieval_channel_snapshots: [declaration("path_relations")],
    embedding_generation_and_model: declaration("embedding_generation_and_model"),
    path_graph_generation: declaration("path_graph_generation"),
    temporal_index_generation: declaration("temporal_index_generation"),
    governance_frontier: declaration("governance_frontier"),
    formation_operator_versions: [["relation_assertion_projection_v1", "1"]],
    decision_contract_digest: `sha256:${"b".repeat(64)}`
  });
  return Object.freeze({
    snapshot_vector,
    snapshot_receipt: createSnapshotCoherenceReceiptV1(snapshot_vector)
  });
}
