import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { CoarseCandidateDraft } from "../../recall/coarse-filter/coarse-candidates.js";
import { addContentDerivedExpansionCandidates } from "../../recall/expansion/content-expansion.js";
import { deriveFacetsFromText } from "../../recall/expansion/facet-keywords.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("content expansion cohort indexing", () => {
  it("admits concept-matched memories without lexical term fitting", () => {
    const cousin = conceptMemory("cousin", "Alice is my cousin and attended graduation.");
    const sibling = conceptMemory("sibling", "Bob is my sibling and attended graduation.");
    const business = conceptMemory("business", "Acme is our business partner.");
    const technology = conceptMemory("technology", "Contoso is a technology partner.");
    const admitted: string[] = [];

    addContentDerivedExpansionCandidates({
      tierMemories: [cousin, sibling, business, technology],
      drafts: new Map(),
      queryProbes: compileRecallQueryProbes("Which relative attended graduation?"),
      addCandidate: (entry, plane) => {
        if (plane === "facet_concept") admitted.push(entry.object_id);
        return true;
      },
      dynamicRecallPlaneCap: 10,
      dynamicRecallCohortRadius: 1
    });

    expect(admitted).toEqual([cousin.object_id, sibling.object_id]);
  });

  it("reuses one ordered cohort scan while preserving per-seed neighbors", () => {
    const reads = { count: 0 };
    const memories = Array.from({ length: 100 }, (_, index) =>
      instrumentCohortFields(createCohortMemory(index), reads)
    );
    const seeds = memories.slice(0, 50);
    const admitted: string[] = [];

    addContentDerivedExpansionCandidates({
      tierMemories: memories,
      drafts: createSeedDrafts(seeds),
      queryProbes: compileRecallQueryProbes(null),
      addCandidate: (entry, plane) => {
        if (plane === "session_surface_cohort") {
          admitted.push(entry.object_id);
        }
        return true;
      },
      dynamicRecallPlaneCap: 100,
      dynamicRecallCohortRadius: 1
    });

    expect(admitted).toEqual(expectedNeighborIds(seeds));
    expect(reads.count).toBeLessThanOrEqual(memories.length * 12);
  });
});

function conceptMemory(objectId: string, content: string): MemoryEntry {
  return createMemoryEntry({
    object_id: objectId,
    content,
    facet_tags: deriveFacetsFromText(content).map((facet) => ({ facet }))
  });
}

function createCohortMemory(index: number): MemoryEntry {
  const shared = index < 50;
  return createMemoryEntry({
    object_id: `memory-${index.toString().padStart(3, "0")}`,
    created_at: new Date(Date.UTC(2026, 2, 20, 0, index)).toISOString(),
    domain_tags: [],
    surface_id: shared ? "surface-shared" : `surface-${index}`,
    run_id: shared ? "run-shared" : `run-${index}`
  });
}

function instrumentCohortFields(
  entry: MemoryEntry,
  reads: { count: number }
): MemoryEntry {
  const { surface_id: surfaceId, run_id: runId } = entry;
  return Object.defineProperties({ ...entry }, {
    surface_id: { enumerable: true, get: () => readField(reads, surfaceId) },
    run_id: { enumerable: true, get: () => readField(reads, runId) }
  });
}

function readField(reads: { count: number }, value: string | null): string | null {
  reads.count += 1;
  return value;
}

function createSeedDrafts(
  seeds: readonly Readonly<MemoryEntry>[]
): ReadonlyMap<string, CoarseCandidateDraft> {
  return new Map(seeds.map((entry) => [entry.object_id, {
    entry,
    admissionPlanes: ["lexical"],
    firstAdmissionPlane: "lexical",
    sourceChannels: ["test"],
    structuralScore: 1,
    pathExpansionSources: []
  }]));
}

function expectedNeighborIds(
  seeds: readonly Readonly<MemoryEntry>[]
): readonly string[] {
  return seeds.flatMap((_, index) => [
    ...(index === 0 ? [] : [seeds[index - 1]!.object_id]),
    ...(index === seeds.length - 1 ? [] : [seeds[index + 1]!.object_id])
  ]);
}
