import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallRetrievalFieldBundle } from
  "../../recall/field/retrieval/retrieval-field-bundle.js";
import type {
  RecallServiceMemoryRepoPort,
  RecallServiceSynthesisSearchPort
} from "../../recall/runtime/recall-service-ports.js";
import { collectSynthesisChildCandidates } from "../../recall/supplements/synthesis/child-candidates.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("collectSynthesisChildCandidates", () => {
  it("selects deterministic semantic contents when equal synthesis ranks exceed global cap", async () => {
    const workspaceId = "workspace-1";
    const queryText = "synthesis child test query";
    const queryProbes = compileRecallQueryProbes(queryText);

    // Create 50 distinct semantic contents.
    const semanticItems = Array.from({ length: 50 }, (_, index) => {
      const paddedIndex = String(index).padStart(2, "0");
      return {
        content: `Semantic memory content item ${paddedIndex}`,
        dimension: "procedure" as const,
        scope_class: "project" as const
      };
    });

    // Permutation A: Map each semantic item to ID A and timestamp A
    const memoryEntriesA: MemoryEntry[] = semanticItems.map((item, index) => {
      const permutedIdIndex = (index * 17 + 3) % 50;
      const permutedTimeIndex = (index * 13 + 7) % 50;
      return createMemoryEntry({
        object_id: `mem-id-A-${String(permutedIdIndex).padStart(2, "0")}`,
        content: item.content,
        dimension: item.dimension,
        scope_class: item.scope_class,
        workspace_id: workspaceId,
        lifecycle_state: "active",
        created_at: `2026-01-01T${String(permutedTimeIndex % 24).padStart(2, "0")}:00:00.000Z`
      });
    });

    // Permutation B: Map SAME 50 semantic items to DIFFERENT ID B and timestamp B
    const memoryEntriesB: MemoryEntry[] = semanticItems.map((item, index) => {
      const permutedIdIndex = (index * 31 + 11) % 50;
      const permutedTimeIndex = (index * 7 + 19) % 50;
      return createMemoryEntry({
        object_id: `mem-id-B-${String(permutedIdIndex).padStart(2, "0")}`,
        content: item.content,
        dimension: item.dimension,
        scope_class: item.scope_class,
        workspace_id: workspaceId,
        lifecycle_state: "active",
        created_at: `2026-01-02T${String(permutedTimeIndex % 24).padStart(2, "0")}:00:00.000Z`
      });
    });

    const runCollect = async (entries: readonly MemoryEntry[]) => {
      const entryMap = new Map(entries.map((e) => [e.object_id, e]));
      const memoryIds = entries.map((e) => e.object_id);

      // Split 50 items across 5 synthesis capsules (10 items each <= 20 per-capsule limit)
      const capsules = Array.from({ length: 5 }, (_, capsuleIdx) => {
        const capsuleId = `synth-capsule-${capsuleIdx + 1}`;
        const sourceRefs = memoryIds.slice(capsuleIdx * 10, (capsuleIdx + 1) * 10);
        return {
          object_id: capsuleId,
          workspace_id: workspaceId,
          source_memory_refs: sourceRefs
        };
      });

      return await collectSynthesisChildCandidates({
        dependencies: {
          memoryRepo: {
            findByIds: async (_ws: string, ids: readonly string[]) =>
              ids.map((id) => entryMap.get(id)).filter((e): e is MemoryEntry => e !== undefined)
          } as unknown as RecallServiceMemoryRepoPort
        },
        workspaceId,
        queryText,
        queryProbes,
        synthesisSearchPort: {
          findByIds: async (_ws: string, ids: readonly string[]) =>
            capsules.filter((cap) => ids.includes(cap.object_id))
        } as unknown as RecallServiceSynthesisSearchPort,
        retrievalFieldBundle: {
          searchSynthesisKeywords: async () => [
            capsules.map((cap) => ({ object_id: cap.object_id, normalized_rank: 0.8 }))
          ]
        } as unknown as RecallRetrievalFieldBundle,
        limit: 50
      });
    };

    const resultA = await runCollect(memoryEntriesA);
    const resultB = await runCollect(memoryEntriesB);

    expect(resultA.candidates).toHaveLength(40);
    expect(resultB.candidates).toHaveLength(40);

    const contentsA = resultA.candidates.map((c) => c.entry.content);
    const contentsB = resultB.candidates.map((c) => c.entry.content);

    // Re-IDing / permuting timestamps of semantically identical MemoryEntry rows
    // must select the exact same 40 semantic contents.
    expect(contentsA).toEqual(contentsB);
  });
});
