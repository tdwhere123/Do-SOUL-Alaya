import { describe, expect, it } from "vitest";
import {
  materializeSupportFromReceipts,
  type SupportCandidateReceiptV1
} from "../../../../recall/shadow/support/index.js";
import { QUERY } from "./fixtures.js";
import {
  authorityContext,
  createRelationalReceipt,
  polarityCandidate,
  polarityReceipt,
  RELATIONAL_SNAPSHOT,
  supersessionReceipt
} from "./relational-authority-fixtures.js";

const PROP = "prop.works-at";

describe("support adapter ordering", () => {
  it("projects multiple propositions identically across receipt permutations", () => {
    const propositionZ = polarityFor(
      "candidate-z",
      "lineage-z",
      "prop.z",
      "positive"
    );
    const supersedeZ: SupportCandidateReceiptV1 = {
      candidate_key: "candidate-z-supersession",
      supersession: {
        status: "available",
        value: {
          standing: "superseded",
          lineage_id: "lineage-z",
          proposition_id: "prop.z",
          receipt: supersessionReceipt("lineage-z", "prop.z")
        }
      }
    };
    const propositionA = polarityFor(
      "candidate-a",
      "lineage-a",
      "prop.a",
      "positive"
    );

    const forward = materializePolarity([propositionZ, supersedeZ, propositionA]);
    const reverse = materializePolarity([propositionA, supersedeZ, propositionZ]);

    expect(forward.polarities).toEqual(reverse.polarities);
    expect(forward.polarities.map((witness) => [
      witness.identity.proposition_id,
      witness.payload.polarity,
      witness.provenance
    ])).toEqual([
      ["prop.a", "supported_only", [
        { source_id: "support.adapter", producer: "support.polarity.v1" }
      ]],
      ["prop.z", "unknown", [
        { source_id: "support.adapter", producer: "support.polarity.v1" }
      ]]
    ]);
    expect(forward.proposition_observations).toEqual(reverse.proposition_observations);
  });

  it("resolves supersession identically before or after the superseded vote", () => {
    const support = polarityCandidate(
      "candidate-support",
      "lineage-current",
      "positive",
      polarityReceipt("lineage-current")
    );
    const refute = polarityCandidate(
      "candidate-refute",
      "lineage-superseded",
      "negative",
      polarityReceipt("lineage-superseded")
    );
    const supersession: SupportCandidateReceiptV1 = {
      candidate_key: "candidate-supersession",
      supersession: {
        status: "available",
        value: {
          standing: "superseded",
          lineage_id: "lineage-superseded",
          proposition_id: PROP,
          receipt: supersessionReceipt("lineage-superseded", PROP)
        }
      }
    };

    const forward = materializePolarity([support, supersession, refute]);
    const reverse = materializePolarity([refute, supersession, support]);

    expect(forward.polarities).toEqual(reverse.polarities);
    expect(forward.polarities[0]).toMatchObject({
      epistemic: { kind: "exact" },
      payload: { polarity: "supported_only" }
    });
    expect(forward.proposition_observations).toEqual(reverse.proposition_observations);
    expect(forward.proposition_observations.find(({ candidate_id }) =>
      candidate_id === "candidate-refute")?.witness.payload).toEqual({ polarity: "unknown" });
  });

  it("keeps OSF correlation provenance canonical across receipt permutations", () => {
    const candidates = lineageCandidates();
    const forward = materializeOsf(candidates);
    const reverse = materializeOsf([...candidates].reverse());

    expect(forward.graph.digest).toBe(reverse.graph.digest);
    expect(forward.graph.correlations).toEqual(reverse.graph.correlations);
    expect(forward.graph.correlations).toEqual([
      { left_id: "evidence-a", right_id: "evidence-shared", state: "same_source_lineage" },
      { left_id: "evidence-b", right_id: "evidence-shared", state: "same_source_lineage" }
    ]);
  });

  it("preserves every conflicting lineage assertion for one evidence unit", () => {
    const result = materializeOsf(lineageCandidates());
    const lineageEdges = result.graph.edges.filter((edge) =>
      edge.kind === "sourced_from" && edge.from.id === "evidence-shared");

    expect(lineageEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: { kind: "source_lineage", id: "lineage-a" } }),
      expect.objectContaining({ to: { kind: "source_lineage", id: "lineage-b" } })
    ]));
    expect(lineageEdges).toHaveLength(2);
    expect(result.graph.correlations).toEqual(expect.arrayContaining([
      expect.objectContaining({ left_id: "evidence-a", right_id: "evidence-shared" }),
      expect.objectContaining({ left_id: "evidence-b", right_id: "evidence-shared" })
    ]));
  });
});

function materializePolarity(candidates: readonly SupportCandidateReceiptV1[]) {
  return materializeSupportFromReceipts({
    query_id: QUERY,
    snapshot_digest: RELATIONAL_SNAPSHOT,
    authority_context: authorityContext(),
    candidates
  });
}

function materializeOsf(candidates: readonly SupportCandidateReceiptV1[]) {
  return materializeSupportFromReceipts({
    query_id: QUERY,
    snapshot_digest: `sha256:${"c".repeat(64)}`,
    candidates
  });
}

function polarityFor(
  candidateKey: string,
  lineageId: string,
  propositionId: string,
  polarity: "positive" | "negative"
): SupportCandidateReceiptV1 {
  const context = authorityContext();
  const subject = {
    kind: "polarity" as const,
    proposition_id: propositionId,
    lineage_id: lineageId
  };
  return {
    candidate_key: candidateKey,
    polarity: {
      status: "available",
      value: {
        polarity,
        lineage_id: lineageId,
        proposition_id: propositionId,
        receipt: createRelationalReceipt(context, subject, {})
      }
    }
  };
}

function lineageCandidates(): readonly SupportCandidateReceiptV1[] {
  return [
    osfCandidate("candidate-a", "evidence-shared", "lineage-a"),
    osfCandidate("candidate-b", "evidence-shared", "lineage-b"),
    osfCandidate("candidate-a-peer", "evidence-a", "lineage-a"),
    osfCandidate("candidate-b-peer", "evidence-b", "lineage-b")
  ];
}

function osfCandidate(
  candidateKey: string,
  evidenceId: string,
  lineageId: string
): SupportCandidateReceiptV1 {
  return {
    candidate_key: candidateKey,
    osf: {
      composition_status: "composed",
      truncated: false,
      bindings: [{
        variable_id: "x",
        binding_identity: `binding:${candidateKey}`,
        semantic_identity: `semantic:${candidateKey}`,
        evidence_id: evidenceId,
        query_proposition_id: PROP,
        source_lineage_id: lineageId
      }]
    }
  };
}
