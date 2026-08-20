import { describe, expect, it } from "vitest";

import {
  buildFineAssessmentComponentLedger
} from
  "../../recall/delivery/selection-boundary/selection-boundary-component-ledger.js";
import {
  reconstructFineAssessmentComposition
} from
  "../../recall/delivery/selection-boundary/selection-boundary-composition.js";
import {
  selectionBoundaryJsonSha256
} from
  "../../recall/delivery/selection-boundary/selection-boundary-json.js";
import { observeNumericSource } from
  "../../recall/delivery/selection-boundary/selection-boundary-component-ledger-sources.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import { captureFineAssessmentSelectionBoundary } from
  "./selection-boundary-live-capture-fixture.js";
import { evidenceSemanticActivation } from
  "./fixtures/evidence-semantic-activation.js";

describe("observeNumericSource", () => {
  it("distinguishes ineligible, absent, observed zero, positive, and invalid", () => {
    expect(observeNumericSource(false, 0.5)).toMatchObject({
      state: "ineligible",
      raw: null,
      unit_interval: null
    });
    expect(observeNumericSource(true, undefined)).toMatchObject({
      state: "absent",
      raw: null,
      unit_interval: null
    });
    expect(observeNumericSource(true, 0)).toMatchObject({
      state: "observed_zero",
      raw: 0,
      unit_interval: 0
    });
    expect(observeNumericSource(true, 0.75)).toMatchObject({
      state: "observed_positive",
      raw: 0.75,
      unit_interval: 0.75
    });
    expect(observeNumericSource(true, Number.NaN)).toMatchObject({
      state: "invalid",
      raw: null,
      unit_interval: null
    });
    expect(observeNumericSource(true, -0.2)).toMatchObject({
      state: "invalid",
      raw: -0.2,
      unit_interval: null
    });
  });
});

describe("fine-assessment component ledger", () => {
  it("derives source-separated fields without text or gold", () => {
    const boundary = withObservedAgreements(captureLiveBoundary());
    const ledger = buildFineAssessmentComponentLedger(boundary);
    const first = ledger.candidates[0]!;

    expect(ledger.schema_version).toBe(1);
    expect(ledger.units.fused_score).toBe("flood_integrated_final");
    expect(ledger.units.rrf_family_contribution).toBe("rrf_rank_ballot");
    expect(first.sources.evidence_fts.state).toBe("observed_positive");
    expect(first.sources.lexical_fts.state).toBe("observed_positive");
    expect(first.sources.trigram_fts.state).toBe("observed_positive");
    expect(first.sources.structural_supplementary.state).toBe("observed_positive");
    expect(first.activation).toMatchObject({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      missing_channel_policy: "no_op"
    });
    expect(first.lexical_agreement).toBeGreaterThan(0);
    expect(first.evidence_agreement).toBeGreaterThan(0);
    expect(first.duplicate_evidence.lexical_trigram_family_max_then_geometric)
      .toBe(true);
    expect(
      first.duplicate_evidence
        .flood_vs_receipt_evidence_agreement_independence_assumed
    ).toBe(false);
    expect(first.selection_inputs.delivery_rank).toBeTypeOf("number");
    assertLedgerHasNoTextOrGold(ledger);
  });

  it("keeps missing embedding distinct from observed zero", () => {
    const boundary = withEmbeddingSourceCases(captureLiveBoundary());
    const ledger = buildFineAssessmentComponentLedger(boundary);
    const byKey = new Map(
      ledger.candidates.map((row) => [row.candidate_key, row] as const)
    );
    const keys = boundary.input.ordered_candidates.map(
      (candidate) => candidate.fusion.candidate_key
    );

    expect(byKey.get(keys[0]!)!.selected_embedding).toMatchObject({
      source: "none",
      observation: { state: "absent" }
    });
    expect(byKey.get(keys[1]!)!.selected_embedding).toMatchObject({
      source: "effective_factor",
      observation: { state: "observed_zero", raw: 0, unit_interval: 0 }
    });
    expect(byKey.get(keys[2]!)!.selected_embedding).toMatchObject({
      source: "effective_factor",
      observation: { state: "observed_positive", raw: 0.6, unit_interval: 0.6 }
    });
    expect(byKey.get(keys[1]!)!.duplicate_evidence.embedding_in_deep_head)
      .toBe(true);
    expect(byKey.get(keys[0]!)!.duplicate_evidence.embedding_in_deep_head)
      .toBe(false);
  });

  it("reports an evidence winner only when evidence semantic activation wins", () => {
    const baseline = captureLiveBoundary();
    const [firstKey, secondKey] = baseline.input.ordered_candidates.map(
      (candidate) => candidate.fusion.candidate_key
    );
    const winner = {
      score: 0.9,
      evidenceObjectId: "evidence-1",
      documentIdentity: "fact_key:5",
      projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        matched_fact_key_forms: [{
          kind: "leave_one_slot_out",
          omitted_slot: { slot_index: 2, role: "value" }
        }]
      }
    } as const;
    const lowerWinner = {
      score: 0.2,
      evidenceObjectId: "evidence-2",
      documentIdentity: "owner",
      projection: {
        projection_id: null,
        projection_kind: "owner",
        matched_fact_key_forms: []
      }
    } as const;
    const candidates = baseline.input.ordered_candidates.map((candidate, index) => ({
      ...candidate,
      effectiveFactors: {
        ...candidate.effectiveFactors,
        embedding_similarity: index === 0 ? 0.9 : index === 1 ? 0.8 : 0
      }
    }));
    const boundary = {
      ...baseline,
      input: {
        ...baseline.input,
        ordered_candidates: candidates,
        supplementary_data: {
          ...baseline.input.supplementary_data,
          evidenceSemanticActivationsByCandidateKey: [
            [firstKey!, evidenceSemanticActivation(0.9, winner)],
            [secondKey!, evidenceSemanticActivation(0.2, lowerWinner)]
          ]
        }
      }
    } as unknown as FineAssessmentSelectionBoundaryCase;

    const ledger = buildFineAssessmentComponentLedger(boundary);
    const byKey = new Map(
      ledger.candidates.map((row) => [row.candidate_key, row] as const)
    );
    const evidenceSelected = byKey.get(firstKey!)!.selected_embedding as unknown as {
      readonly source: string;
      readonly winner?: Readonly<{
        readonly score: number;
        readonly evidence_object_id: string;
        readonly document_identity: string;
        readonly projection: unknown;
      }> | null;
    };
    const effectiveSelected = byKey.get(secondKey!)!.selected_embedding as unknown as {
      readonly source: string;
      readonly winner?: unknown;
    };

    expect(evidenceSelected).toEqual({
      source: "evidence_semantic",
      observation: expect.objectContaining({ raw: 0.9 }),
      winner: {
        score: 0.9,
        evidence_object_id: "evidence-1",
        document_identity: "fact_key:5",
        projection: winner.projection
      }
    });
    expect(effectiveSelected).toMatchObject({
      source: "effective_factor",
      winner: null
    });
    const coverage = byKey.get(firstKey!)!.coverage;
    expect(coverage.activation).toEqual(byKey.get(firstKey!)!.activation);
    expect(coverage.atoms.map((atom) => atom.kind)).toEqual([
      "logical_object",
      "independent_evidence",
      "fact_projection"
    ]);
    expect(coverage.atoms[1]!.independence_key)
      .toBe(coverage.atoms[2]!.independence_key);
  });

  it("distinguishes absent evidence_fts from observed zero before ?? 0", () => {
    const boundary = withEvidenceFtsStates(captureLiveBoundary());
    const ledger = buildFineAssessmentComponentLedger(boundary);
    const byId = new Map(
      ledger.candidates.map((row) => [row.object_id, row] as const)
    );
    const ids = boundary.input.ordered_candidates.map(
      (candidate) => candidate.entry.object_id
    );

    expect(byId.get(ids[0]!)!.sources.evidence_fts.state).toBe("absent");
    expect(byId.get(ids[1]!)!.sources.evidence_fts).toMatchObject({
      state: "observed_zero",
      raw: 0,
      unit_interval: 0
    });
    expect(byId.get(ids[2]!)!.sources.evidence_fts).toMatchObject({
      state: "observed_positive",
      raw: 0.4,
      unit_interval: 0.4
    });
  });

  it("exposes fusion RRF vs non-embedding base and duplicate evidence flags", () => {
    const boundary = withFusionDuplicateEvidence(captureLiveBoundary());
    const ledger = buildFineAssessmentComponentLedger(boundary);
    const row = ledger.candidates[0]!;

    expect(row.fusion.embedding_rrf_contribution).toBeGreaterThan(0);
    expect(row.fusion.rrf_family_total).toBeGreaterThan(
      row.fusion.non_embedding_object_base
    );
    expect(row.duplicate_evidence.embedding_in_fusion_rrf).toBe(true);
    expect(row.duplicate_evidence.evidence_fts_in_fusion_rrf).toBe(true);
    expect(row.duplicate_evidence.evidence_fts_in_evidence_agreement).toBe(true);
  });

  it("does not alter composition packet digests when derived first", () => {
    const boundary = captureLiveBoundary();
    const before = selectionBoundaryJsonSha256(boundary);
    const ledger = buildFineAssessmentComponentLedger(boundary);
    expect(selectionBoundaryJsonSha256(boundary)).toBe(before);
    expect(ledger.candidates.length).toBe(
      boundary.input.ordered_candidates.length
    );

    const reconstructed = reconstructFineAssessmentComposition(boundary);
    expect(selectionBoundaryJsonSha256(boundary)).toBe(before);
    expect(
      reconstructed.result.candidates.map((candidate) => candidate.object_id)
    ).toEqual(
      boundary.expected.candidate_keys.map((key) => key.split(":").at(-1))
    );
  });
});

function captureLiveBoundary(): FineAssessmentSelectionBoundaryCase {
  return captureFineAssessmentSelectionBoundary(
    "surface-selection-component-ledger"
  );
}

function assertLedgerHasNoTextOrGold(
  ledger: ReturnType<typeof buildFineAssessmentComponentLedger>
): void {
  const serialized = JSON.stringify(ledger);
  expect(serialized).not.toMatch(/gold|expected_answer|qid|question_id/i);
  expect(serialized).not.toContain("Recall content for");
  for (const row of ledger.candidates) {
    expect(row).not.toHaveProperty("content");
    expect(row).not.toHaveProperty("gist");
    expect(row).not.toHaveProperty("text");
  }
}

function withObservedAgreements(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const firstId = boundary.input.ordered_candidates[0]!.entry.object_id;
  return patchSupplementary(boundary, {
    structuralScores: { [firstId]: 0.7 },
    sourceProximityScores: { [firstId]: 0.5 }
  });
}

function withEmbeddingSourceCases(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const candidates = boundary.input.ordered_candidates.map((candidate, index) => {
    if (index === 0) {
      const { embedding_similarity: _drop, ...factors } = candidate.effectiveFactors;
      return { ...candidate, effectiveFactors: factors };
    }
    if (index === 1) {
      return {
        ...candidate,
        effectiveFactors: {
          ...candidate.effectiveFactors,
          embedding_similarity: 0
        }
      };
    }
    if (index === 2) {
      return {
        ...candidate,
        effectiveFactors: {
          ...candidate.effectiveFactors,
          embedding_similarity: 0.6
        }
      };
    }
    return candidate;
  });
  return {
    ...boundary,
    input: {
      ...boundary.input,
      ordered_candidates: candidates,
      supplementary_data: {
        ...boundary.input.supplementary_data,
        embeddingSimilarityScores: {},
        evidenceSemanticActivationsByCandidateKey: []
      }
    }
  };
}

function withEvidenceFtsStates(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const ids = boundary.input.ordered_candidates.map(
    (candidate) => candidate.entry.object_id
  );
  return patchSupplementary(boundary, {
    evidenceFtsRanks: {
      [ids[1]!]: 0,
      [ids[2]!]: 0.4
    }
  });
}

function withFusionDuplicateEvidence(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const [first, ...rest] = boundary.input.ordered_candidates;
  const patched = {
    ...first!,
    fusion: {
      ...first!.fusion,
      per_stream_rank: {
        ...first!.fusion.per_stream_rank,
        embedding_similarity: 2,
        evidence_fts: 3,
        lexical_fts: 4
      },
      fused_rank_contribution_per_stream: {
        ...first!.fusion.fused_rank_contribution_per_stream,
        embedding_similarity: 0.2,
        evidence_fts: 0.15,
        lexical_fts: 0.1
      }
    },
    effectiveFactors: {
      ...first!.effectiveFactors,
      embedding_similarity: 0.55
    }
  };
  return {
    ...boundary,
    input: {
      ...boundary.input,
      ordered_candidates: [patched, ...rest]
    }
  };
}

function patchSupplementary(
  boundary: FineAssessmentSelectionBoundaryCase,
  overrides: Partial<FineAssessmentSelectionBoundaryCase["input"]["supplementary_data"]>
): FineAssessmentSelectionBoundaryCase {
  return {
    ...boundary,
    input: {
      ...boundary.input,
      supplementary_data: {
        ...boundary.input.supplementary_data,
        ...overrides
      }
    }
  };
}
