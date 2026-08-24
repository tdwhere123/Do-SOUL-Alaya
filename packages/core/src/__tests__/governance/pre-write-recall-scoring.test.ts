import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import {
  compareCandidateNeighbors,
  compareStructuralCandidate,
  type StructuralCandidate
} from "../../governance/reconciliation/pre-write-recall-scoring.js";
import type { PreWriteCandidateNeighbor } from
  "../../governance/reconciliation/pre-write-recall-service.js";

function makeEntry(objectId: string, content: string): Readonly<MemoryEntry> {
  return {
    object_id: objectId,
    content,
    workspace_id: "ws-1",
    domain_tags: ["tag-1"],
    canonical_entities: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z"
  } as unknown as Readonly<MemoryEntry>;
}

describe("pre-write-recall-scoring candidate tie-breaking", () => {
  it("sorts equal score structural candidates by normalized semantic content before object_id", () => {
    const left: StructuralCandidate = {
      entry: makeEntry("id-1", "Zebra lives in savanna"),
      score: 0.8,
      families: ["domain_tag"]
    };
    const right: StructuralCandidate = {
      entry: makeEntry("id-2", "Apple lives in orchard"),
      score: 0.8,
      families: ["domain_tag"]
    };

    // Equal score: "Apple..." comes before "Zebra..." semantically.
    expect(compareStructuralCandidate(left, right)).toBeGreaterThan(0);
    expect(compareStructuralCandidate(right, left)).toBeLessThan(0);
  });

  it("sorts equal score candidate neighbors by normalized semantic content, using object_id only for byte-identical content", () => {
    const neighborA: PreWriteCandidateNeighbor = {
      entry: makeEntry("id-1", "  Zebra lives in savanna  "),
      lexicalScore: 0.8,
      structuralScore: 0.8,
      tagScore: 0,
      entityScore: 0,
      slotScore: 0,
      temporalScore: 0,
      families: ["domain_tag"],
      relationPosteriors: []
    };
    const neighborB: PreWriteCandidateNeighbor = {
      entry: makeEntry("id-2", "Apple lives in orchard"),
      lexicalScore: 0.8,
      structuralScore: 0.8,
      tagScore: 0,
      entityScore: 0,
      slotScore: 0,
      temporalScore: 0,
      families: ["domain_tag"],
      relationPosteriors: []
    };

    // Equal score and family count: "Apple..." comes before "Zebra..." semantically.
    expect(compareCandidateNeighbors(neighborA, neighborB)).toBeGreaterThan(0);
    expect(compareCandidateNeighbors(neighborB, neighborA)).toBeLessThan(0);

    // Byte-identical content: object_id resolves tie deterministically ("id-1" < "id-2").
    const neighborC: PreWriteCandidateNeighbor = {
      ...neighborA,
      entry: makeEntry("id-2", "Zebra lives in savanna")
    };
    const neighborD: PreWriteCandidateNeighbor = {
      ...neighborA,
      entry: makeEntry("id-1", "Zebra lives in savanna")
    };
    expect(compareCandidateNeighbors(neighborC, neighborD)).toBeGreaterThan(0);
    expect(compareCandidateNeighbors(neighborD, neighborC)).toBeLessThan(0);
  });
});
