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
    expect(result.graph.edges.some((edge) => edge.kind === "sourced_from")).toBe(true);
    expect(result.polarities[0]?.payload?.polarity).toBe("supported_only");
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
