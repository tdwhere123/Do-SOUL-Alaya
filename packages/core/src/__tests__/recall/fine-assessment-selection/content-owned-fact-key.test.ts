import { describe, expect, it } from "vitest";

import type { CandidateCoverageReceipt } from
  "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import {
  attachContentOwnedFactProjection,
  CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID,
  CONTENT_OWNED_FACT_KEY_PROJECTION_ID,
  isContentOwnedAssertionFactAtom
} from "../../../recall/delivery/fine-assessment-selection/content-owned-fact-key.js";

describe("content-owned assertion fact projection", () => {
  it("adds the content atom beside an existing unrelated fact projection", () => {
    const coverage = receipt([unrelatedFact("memory-a")]);
    const attached = attachContentOwnedFactProjection(coverage, {
      objectId: "memory-a",
      content: "graduated with a degree in mathematics"
    });

    expect(attached.atoms.filter((atom) => atom.kind === "fact_projection")).toHaveLength(2);
    expect(attached.atoms).toContainEqual(expect.objectContaining({
      kind: "fact_projection",
      independence_key: `${CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID}:memory-a`,
      document_identity: `${CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID}:memory-a`,
      projection: expect.objectContaining({
        fact_slots: [expect.objectContaining({
          role: "value",
          text: "graduated with a degree in mathematics"
        })]
      })
    }));
  });

  it("still joins empty evidence refs through owned content", () => {
    const attached = attachContentOwnedFactProjection(receipt([]), {
      objectId: "memory-empty",
      content: "I did volunteer at the clinic"
    });

    const owned = attached.atoms.find((atom) =>
      atom.independence_key === `${CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID}:memory-empty`
    );
    expect(owned?.matched_fts_lanes).toBeUndefined();
    expect(owned !== undefined && isContentOwnedAssertionFactAtom(owned)).toBe(true);
  });

  it("does not treat a prefix-spoofed evidence atom as owned assertion", () => {
    const spoof = {
      ...unrelatedFact("memory-a"),
      independence_key: `${CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID}:memory-a`,
      document_identity: `${CONTENT_OWNED_ASSERTION_FACT_KEY_OPERATOR_ID}:memory-a`
    };
    expect(isContentOwnedAssertionFactAtom(spoof)).toBe(false);
    expect(isContentOwnedAssertionFactAtom({
      ...spoof,
      evidence_object_id: null,
      projection: {
        ...spoof.projection!,
        projection_id: CONTENT_OWNED_FACT_KEY_PROJECTION_ID
      }
    })).toBe(false);
  });
});

function receipt(
  atoms: CandidateCoverageReceipt["atoms"]
): CandidateCoverageReceipt {
  return Object.freeze({
    schema_version: 1,
    operator_id: "attributed_coverage_atoms_v1",
    candidate_key: "candidate-a",
    activation: Object.freeze({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      state: "absent",
      score: null,
      winner: null,
      observations: Object.freeze([]),
      missing_channel_policy: "no_op"
    }),
    evidence_semantic_completeness: "not_observed",
    projection_match_count: atoms.length,
    atoms: Object.freeze([...atoms])
  });
}

function unrelatedFact(objectId: string): CandidateCoverageReceipt["atoms"][number] {
  return Object.freeze({
    atom_id: `fact:${objectId}:7`,
    kind: "fact_projection",
    strength: 0.8,
    independence_key: `evidence:${objectId}`,
    evidence_object_id: objectId,
    document_identity: "fact_key:7",
    projection: Object.freeze({
      projection_id: 7,
      projection_kind: "fact_key" as const,
      matched_fact_key_forms: Object.freeze([{ kind: "complete" as const }]),
      fact_slots: Object.freeze([
        Object.freeze({ role: "value" as const, text: "a red apple" })
      ])
    }),
    demand_roles: Object.freeze(["value"] as const),
    observation_channels: Object.freeze([])
  });
}
