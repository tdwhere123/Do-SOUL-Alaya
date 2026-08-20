import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  orderByCoverageMarginalGain,
  resolveCoverageIdentity,
  type CoverageMarginalObservation,
  type CoverageSelectionObjective
} from "../../recall/delivery/coverage-selection.js";
import type { CandidateCoverageReceipt } from
  "../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { evidenceSemanticActivation } from
  "./fixtures/evidence-semantic-activation.js";
import {
  captureCoverageReceipt,
  createCandidate,
  createRanks,
  createSupplementaryData,
  legacyCoveragePass,
  relevanceMap,
  withDimension
} from "./coverage-selection-test-support.js";

describe("coverage-aware delivery atoms", () => {
  it("passes source-attributed coverage atoms through the one selector seam", () => {
    const baseCandidate = createCandidate("first", 0.99);
    const candidate = {
      ...baseCandidate,
      entry: { ...baseCandidate.entry, evidence_refs: ["evidence-1"] }
    };
    const winner = {
      score: 0.9,
      evidenceObjectId: "evidence-1",
      documentIdentity: "fact_key:5:strong",
      projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        matched_fact_key_forms: [
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 2, role: "value" } },
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 4, role: "time" } },
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 2, role: "value" } }
        ],
        fact_slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "bought" },
          { role: "value", text: "a bookshelf" },
          { role: "time", text: "last year" }
        ]
      }
    } as const;
    const weakerAlias = {
      score: 0.4,
      evidenceObjectId: "evidence-1",
      documentIdentity: "fact_key:5:weak",
      projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        matched_fact_key_forms: [
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 1, role: "relation" } }
        ]
      }
    } as const;
    const independentSource = {
      score: 0.7,
      evidenceObjectId: "evidence-2",
      documentIdentity: "owner",
      projection: {
        projection_id: null,
        projection_kind: "owner",
        matched_fact_key_forms: []
      }
    } as const;
    const receipt = captureCoverageReceipt(
      candidate,
      createSupplementaryData({
        evidenceSemanticActivationsByCandidateKey: new Map([[
          candidate.fusion.candidate_key,
          evidenceSemanticActivation(0.9, winner, [weakerAlias, independentSource])
        ]]),
        evidenceProjectionMatchesByRef: {
          "evidence-1": [{
            evidence_ref: "evidence-1",
            projection_kind: "fact_key",
            projection_id: 5,
            normalized_rank: 0.85,
            matched_fts_lanes: ["porter"],
            fact_key_forms: [{
              kind: "leave_one_slot_out",
              omitted_slot: { slot_index: 0, role: "subject" }
            }],
            fact_slots: [
              { role: "subject", text: "I" },
              { role: "relation", text: "bought" },
              { role: "value", text: "a bookshelf" },
              { role: "time", text: "last year" }
            ]
          }]
        }
      })
    );

    expect(receipt).toMatchObject({
      operator_id: "attributed_coverage_atoms_v1",
      candidate_key: candidate.fusion.candidate_key,
      evidence_semantic_completeness: "complete",
      projection_match_count: 1,
      activation: {
        operator_id: "candidate_semantic_max_v1",
        state: "observed",
        winner: { channel: "evidence_semantic", score: 0.9 }
      }
    });
    expect(receipt.atoms.map((atom) => atom.kind)).toEqual([
      "logical_object",
      "independent_evidence",
      "independent_evidence",
      "fact_projection"
    ]);
    const evidenceAtom = receipt.atoms.find(
      (atom) => atom.atom_id === "evidence:evidence-1"
    )!;
    const factAtom = receipt.atoms.find(
      (atom) => atom.atom_id === "fact:evidence-1:5"
    )!;
    expect(factAtom).toMatchObject({
      strength: 0.9,
      document_identity: "fact_key:5:strong",
      demand_roles: ["subject", "relation", "value", "time"],
      observation_channels: ["evidence_fts", "evidence_semantic"],
      matched_fts_lanes: ["porter"]
    });
    expect(factAtom.projection?.fact_slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: "bought" },
      { role: "value", text: "a bookshelf" },
      { role: "time", text: "last year" }
    ]);
    expect(evidenceAtom.observation_channels).toEqual([
      "evidence_fts",
      "evidence_semantic"
    ]);
    expect(evidenceAtom.matched_fts_lanes).toEqual(["porter"]);
    expect(factAtom.independence_key).toBe(evidenceAtom.independence_key);
  });

  it("materializes A-side Fact-Key atoms without a semantic receipt", () => {
    const baseCandidate = createCandidate("fts-only", 0.8);
    const candidate = {
      ...baseCandidate,
      entry: { ...baseCandidate.entry, evidence_refs: ["evidence-fts"] }
    };
    const receipt = captureCoverageReceipt(candidate, createSupplementaryData({
      evidenceProjectionMatchesByRef: {
        "evidence-fts": [{
          evidence_ref: "evidence-fts",
          projection_kind: "fact_key",
          projection_id: 7,
          normalized_rank: 0.6,
          fact_key_forms: [{
            kind: "leave_one_slot_out",
            omitted_slot: { slot_index: 2, role: "value" }
          }]
        }]
      }
    }));

    expect(receipt).toMatchObject({
      evidence_semantic_completeness: "not_observed",
      projection_match_count: 1,
      activation: { state: "absent", score: null }
    });
    expect(receipt.atoms.map((atom) => atom.kind)).toEqual([
      "logical_object",
      "independent_evidence",
      "fact_projection"
    ]);
    expect(receipt.atoms[2]).toMatchObject({
      atom_id: "fact:evidence-fts:7",
      strength: 0.6,
      demand_roles: ["value"],
      observation_channels: ["evidence_fts"]
    });
  });

  it("does not mint a fact atom without a complete projection identity", () => {
    const baseCandidate = createCandidate("invalid-projection", 0.8);
    const candidate = {
      ...baseCandidate,
      entry: { ...baseCandidate.entry, evidence_refs: ["evidence-incomplete"] }
    };
    const receipt = captureCoverageReceipt(candidate, createSupplementaryData({
      evidenceProjectionMatchesByRef: {
        "evidence-incomplete": [{
          evidence_ref: "evidence-incomplete",
          projection_kind: "fact_key",
          projection_id: null,
          normalized_rank: 0.6,
          fact_key_forms: []
        }]
      }
    }));

    expect(receipt.atoms.map((atom) => atom.kind)).toEqual([
      "logical_object",
      "independent_evidence"
    ]);
    expect(receipt.atoms.some((atom) => atom.atom_id.includes(":null"))).toBe(false);
  });

});
