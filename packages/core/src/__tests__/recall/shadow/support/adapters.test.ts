import { describe, expect, it } from "vitest";
import { materializeSupportFromReceipts } from
  "../../../../recall/shadow/support/index.js";
import { QUERY, SNAPSHOT } from "./fixtures.js";

const CAND = "workspace_local:memory_entry:cand-1";
const CAND_B = "workspace_local:memory_entry:cand-2";

describe("support receipt adapters", () => {
  it("materializes OSF bindings, fact frames, polarity, and evidence lineage", () => {
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
        },
        fact_frames: [{ semantic_identity: "person.alice", role: "entity", evidence_id: "eu-1" }],
        polarity: {
          status: "available",
          value: { polarity: "positive", lineage_id: "lineage-a", proposition_id: "prop.works-at" }
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

  it("emits supersedes from a proposition pair and records an OPEN gap for a single pin", () => {
    const paired = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [{
        candidate_key: CAND,
        supersession: {
          status: "available",
          value: {
            standing: "superseded",
            lineage_id: "lineage-old",
            proposition_id: "prop.old",
            counterpart_proposition_id: "prop.new"
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
      .toEqual(["prop.old"]);
    expect(open.gaps.some((gap) => gap.kind === "supersedes_open")).toBe(true);
  });

  it("collapses opposing distinct lineages to both unless supersession resolves", () => {
    const both = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive"),
        polarityCandidate(CAND_B, "lineage-b", "negative")
      ]
    });
    expect(both.polarities[0]?.payload?.polarity).toBe("both");
    expect(both.polarities[0]?.epistemic.kind).toBe("conflict");

    const resolved = materializeSupportFromReceipts({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      candidates: [
        polarityCandidate(CAND, "lineage-a", "positive"),
        {
          ...polarityCandidate(CAND_B, "lineage-b", "negative"),
          supersession: {
            status: "available",
            value: { standing: "superseded", lineage_id: "lineage-b", proposition_id: "prop.works-at" }
          }
        }
      ]
    });
    expect(resolved.polarities[0]?.payload?.polarity).toBe("supported_only");
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
  polarity: "positive" | "negative"
) {
  return {
    candidate_key: candidateKey,
    polarity: {
      status: "available" as const,
      value: { polarity, lineage_id: lineageId, proposition_id: "prop.works-at" }
    },
    evidence_ids: [`eu-${lineageId}`],
    contradiction: polarity === "negative"
      ? {
        status: "available" as const,
        value: {
          standing: "contradicting" as const,
          lineage_id: lineageId,
          proposition_id: "prop.works-at"
        }
      }
      : undefined
  };
}

function pathMaterialization(extras: { strength?: number; hop?: number; path_count?: number }) {
  return materializeSupportFromReceipts({
    query_id: QUERY,
    snapshot_digest: SNAPSHOT,
    candidates: [{
      candidate_key: CAND,
      path: {
        evidence_basis: ["eu-path", "eu-path"],
        relation_kind: "works_at",
        proposition_id: "prop.works-at",
        ...extras
      }
    }]
  });
}
