import { describe, expect, it } from "vitest";
import { ShadowContractError } from
  "../../../../../recall/decision/contract-primitives.js";
import {
  createSupportHypergraph,
  materializeSupportFromReceipts,
  type SupportCandidateReceiptV1
} from "../../../../../recall/decision/query-proof/support/index.js";
import { QUERY, SNAPSHOT } from "./fixtures.js";
import {
  authorityContext,
  createAuthorityContext,
  createRelationalReceipt,
  materializePath,
  pathReceipt,
  pathSubject,
  polarityCandidate,
  polarityReceipt,
  RELATIONAL_SNAPSHOT
} from "./relational-authority-fixtures.js";

const CAND = "workspace_local:memory_entry:cand-1";
const HYPOTHESIS = `sha256:${"1".repeat(64)}`;
const PROP = "prop.works-at";

describe("support source jurisdiction", () => {
  it("rejects a shape-valid path receipt owned by the wrong source", () => {
    const result = materializePath(authorityContext(), pathReceipt({
      source_owner: "forged_source"
    }));
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.outcomes.some((outcome) => outcome.status === "observed")).toBe(false);
    expect(result.outcomes[0]).toMatchObject({ status: "malformed" });
  });

  it.each([
    ["query", { query_id: "wrong-query" }],
    ["snapshot", { snapshot_digest: `sha256:${"d".repeat(64)}` }],
    ["principal", { principal: "foreign-principal" }]
  ] as const)("rejects a right-source path receipt with the wrong %s", (_label, override) => {
    const result = materializePath(authorityContext(), pathReceipt(override));
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
    expect(result.outcomes.some((outcome) => outcome.status === "observed")).toBe(false);
  });

  it("keeps a shape-valid path receipt unavailable when the lease view is unavailable", () => {
    const context = createAuthorityContext({ sourceView: "unavailable" });
    const receipt = createRelationalReceipt(context, pathSubject(), {});
    const result = materializePath(context, receipt);
    expect(result.outcomes).toContainEqual({
      status: "producer_unavailable",
      owner: CAND,
      source_owner: "path_relations",
      reason: "source_view_unavailable"
    });
    expect(result.outcomes.some((outcome) => outcome.status === "observed")).toBe(false);
    expect(result.graph.nodes.some((node) => node.kind === "proposition")).toBe(false);
  });

  it("does not collapse OSF and polarity provenance for one proposition", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [{
        candidate_key: CAND,
        hypothesis_digest: HYPOTHESIS,
        osf: composedOsf("eu-osf"),
        polarity: {
          status: "available",
          value: {
            polarity: "positive",
            lineage_id: "lineage-a",
            proposition_id: PROP,
            receipt: polarityReceipt("lineage-a")
          }
        },
        evidence_ids: ["eu-osf"]
      }]
    });
    const osf = result.proposition_observations.find((row) => row.jurisdiction === "osf");
    const polarity = result.proposition_observations.find((row) =>
      row.jurisdiction === "relation_assertions");
    expect(osf?.witness.provenance).toEqual([
      { source_id: "eu-osf", producer: "support.osf.grounds.v1" }
    ]);
    expect(polarity?.witness.provenance).toEqual([
      { source_id: "lineage-a", producer: "support.polarity.receipt.v1" }
    ]);
    expect(osf?.witness.provenance).not.toEqual(polarity?.witness.provenance);
  });

  it("keeps truncated OSF truncated and does not observe a missing producer", () => {
    const truncated = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        hypothesis_digest: HYPOTHESIS,
        osf: {
          composition_status: "composed",
          truncated: true,
          bindings: [{
            variable_id: "x",
            binding_identity: "arg.person",
            semantic_identity: "person.alice",
            evidence_id: "eu-1",
            query_proposition_id: PROP
          }]
        }
      }]
    });
    expect(truncated.gaps.some((gap) => gap.kind === "osf_truncated")).toBe(true);
    expect(truncated.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(false);
    expect(truncated.outcomes.some((outcome) => outcome.status === "observed")).toBe(false);
    expect(truncated.proposition_observations[0]).toMatchObject({
      producer_outcome: "truncated",
      jurisdiction: "osf",
      witness: { payload: { polarity: "unknown" } }
    });

    const missing = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{ candidate_key: CAND, hypothesis_digest: HYPOTHESIS }]
    });
    expect(missing.outcomes).toEqual([]);
    expect(missing.gaps.some((gap) => gap.kind === "write_side_formation_absent")).toBe(true);
    expect(missing.proposition_observations).toEqual([]);
  });

  it("fails closed on getter swap and keeps captured bytes after mutation", () => {
    const osf = composedOsf("eu-1");
    const candidate: SupportCandidateReceiptV1 = {
      candidate_key: CAND,
      hypothesis_digest: HYPOTHESIS,
      osf,
      evidence_ids: ["eu-1"]
    };
    const captured = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [candidate]
    });
    osf.truncated = true;
    osf.bindings = [];
    expect(captured.proposition_observations[0]).toMatchObject({
      jurisdiction: "osf",
      producer_outcome: "observed",
      local_proposition_id: PROP
    });
    expect(captured.graph.nodes.some((node) => node.kind === "answer_binding")).toBe(true);

    const poisoned = Object.defineProperty({
      candidate_key: CAND,
      hypothesis_digest: HYPOTHESIS
    }, "osf", {
      enumerable: true,
      get: () => {
        throw new Error("planted getter");
      }
    });
    expect(() => materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [poisoned as SupportCandidateReceiptV1]
    })).toThrow("planted getter");
  });

  it("maps many receipts to one semantic identity without dropping provenance", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [
        osfReceipt("eu-1", "person.alice"),
        osfReceipt("eu-2", "person.alice")
      ]
    });
    const bindings = result.graph.nodes.filter((node) => node.kind === "answer_binding");
    expect(bindings).toEqual([{ kind: "answer_binding", id: "person.alice" }]);
    expect(result.proposition_observations).toHaveLength(1);
    expect(result.proposition_observations[0]?.witness.provenance).toEqual([
      { source_id: "eu-1", producer: "support.osf.grounds.v1" },
      { source_id: "eu-2", producer: "support.osf.grounds.v1" }
    ]);
  });

  it("does not mint exact or same-source-lineage correlation without a producer", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "evidence_unit", id: "eu-1" },
        { kind: "evidence_unit", id: "eu-2" }
      ],
      edges: [{
        kind: "correlated",
        from: { kind: "evidence_unit", id: "eu-1" },
        to: { kind: "evidence_unit", id: "eu-2" }
      }]
    });
    expect(receipt.correlations).toEqual([]);
    const materialized = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [
        osfReceipt("eu-1", "person.alice", "lineage-shared"),
        osfReceipt("eu-2", "person.bob", "lineage-shared")
      ]
    });
    expect(materialized.graph.correlations).toEqual([]);
    expect(materialized.graph.correlations.some((row) =>
      row.state === "same_source_lineage" || row.state === "exact")).toBe(false);
  });

  it("binds admitted observations to query, candidate, snapshot, and principal", () => {
    const result = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      authority_context: authorityContext(),
      candidates: [polarityCandidate(CAND, "lineage-a", "positive", polarityReceipt("lineage-a"))]
    });
    expect(result.proposition_observations[0]).toMatchObject({
      query_id: QUERY,
      snapshot_digest: RELATIONAL_SNAPSHOT,
      candidate_id: CAND,
      principal: "principal-1",
      jurisdiction: "relation_assertions",
      producer_outcome: "observed"
    });
    expect(result.proposition_observations[0]?.source_digest).toMatch(/^sha256:/u);
  });

  it("fails closed when a verifier getter is swapped in", () => {
    const context = createAuthorityContext({ includeVerifiers: false });
    const lawful = authorityContext().relational_source_verifiers!;
    const poisoned = Object.defineProperty({
      source_owner: "path_relations",
      allowed_subject_kinds: ["path_projection"]
    }, "verifySourceObservation", {
      enumerable: true,
      get: () => {
        throw new ShadowContractError("planted verifier getter");
      }
    });
    const receipt = createRelationalReceipt(context, pathSubject(), {});
    expect(() => materializePath({
      ...context,
      relational_source_verifiers: [
        poisoned as (typeof lawful)[number],
        lawful.find((row) => row.source_owner === "relation_assertions")!
      ]
    }, receipt)).toThrow(/planted verifier getter/u);
  });
});

function composedOsf(evidenceId: string, lineageId?: string): NonNullable<
  SupportCandidateReceiptV1["osf"]
> {
  return {
    composition_status: "composed",
    truncated: false,
    bindings: [{
      variable_id: "x",
      binding_identity: "arg.person",
      semantic_identity: "person.alice",
      evidence_id: evidenceId,
      query_proposition_id: PROP,
      ...(lineageId === undefined ? {} : { source_lineage_id: lineageId })
    }]
  };
}

function osfReceipt(
  evidenceId: string,
  semanticIdentity: string,
  lineageId?: string
): SupportCandidateReceiptV1 {
  return {
    candidate_key: CAND,
    hypothesis_digest: HYPOTHESIS,
    osf: {
      composition_status: "composed",
      truncated: false,
      bindings: [{
        variable_id: "x",
        binding_identity: `arg.${semanticIdentity}`,
        semantic_identity: semanticIdentity,
        evidence_id: evidenceId,
        query_proposition_id: PROP,
        ...(lineageId === undefined ? {} : { source_lineage_id: lineageId })
      }]
    },
    evidence_ids: [evidenceId]
  };
}
