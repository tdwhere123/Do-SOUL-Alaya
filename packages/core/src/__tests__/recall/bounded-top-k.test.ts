import { describe, expect, it } from "vitest";
import { selectBoundedTopK } from "../../recall/coarse-filter/selection/bounded-top-k.js";
import { RecallService } from "../../recall/recall-service.js";
import { runCoarseFilter } from "../../recall/coarse-filter/coarse-filter.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

interface RankedValue {
  readonly id: string;
  readonly score: number;
}

const compareRankedValues = (left: RankedValue, right: RankedValue): number =>
  right.score - left.score || left.id.localeCompare(right.id);

describe("selectBoundedTopK", () => {
  it("matches full-sort selection including deterministic ties", () => {
    const values = Array.from({ length: 997 }, (_, index) => ({
      id: `value-${String(996 - index).padStart(4, "0")}`,
      score: (index * 37) % 29
    }));

    expect(selectBoundedTopK(values, 73, compareRankedValues)).toEqual(
      [...values].sort(compareRankedValues).slice(0, 73)
    );
  });

  it("handles empty and unbounded selections", () => {
    const values = [
      { id: "b", score: 1 },
      { id: "a", score: 1 }
    ];

    expect(selectBoundedTopK(values, 0, compareRankedValues)).toEqual([]);
    expect(selectBoundedTopK(values, 5, compareRankedValues)).toEqual([
      { id: "a", score: 1 },
      { id: "b", score: 1 }
    ]);
  });

  it("keeps bounded activation admission stable across replay-local noise", async () => {
    const replayA = [
      createMemoryEntry({
        object_id: "replay-a-zulu",
        content: "Zulu tied memory.",
        created_at: "2026-08-06T06:46:30.150Z",
        activation_score: 0.9324999994168792
      }),
      createMemoryEntry({
        object_id: "replay-a-alpha",
        content: "Alpha tied memory.",
        created_at: "2026-08-06T06:46:20.454Z",
        activation_score: 0.9324999723600726
      }),
      createMemoryEntry({
        object_id: "replay-a-bravo",
        content: "Bravo tied memory.",
        created_at: "2026-08-06T06:46:29.853Z",
        activation_score: 0.9324999990670068
      })
    ];
    const replayB = [
      createMemoryEntry({
        object_id: "replay-b-bravo",
        content: "Bravo tied memory.",
        created_at: "2026-08-06T06:49:04.169Z",
        activation_score: 0.9324999995335034
      }),
      createMemoryEntry({
        object_id: "replay-b-zulu",
        content: "Zulu tied memory.",
        created_at: "2026-08-06T06:49:07.566Z",
        activation_score: 0.9324999990670068
      }),
      createMemoryEntry({
        object_id: "replay-b-alpha",
        content: "Alpha tied memory.",
        created_at: "2026-08-06T06:49:04.148Z",
        activation_score: 0.9324999991836309
      })
    ];
    const selectContents = async (entries: typeof replayA) => {
      const { dependencies, warnSpy } = createDependencies(entries);
      const service = new RecallService(dependencies);
      const basePolicy = service.buildDefaultPolicy(
        "analyze",
        createTaskSurface().runtime_id
      );
      const result = await runCoarseFilter(
        {
          dependencies,
          warn: warnSpy as unknown as (message: string, meta: Record<string, unknown>) => void
        },
        "workspace-1",
        {
          ...basePolicy.coarse_filter,
          deterministic_match: {
            scope_filter: null,
            dimension_filter: null,
            domain_tag_filter: null
          },
          precomputed_rank: { max_candidates: 2, min_activation_score: null },
          semantic_supplement: {
            ...basePolicy.coarse_filter.semantic_supplement,
            enabled: false,
            max_supplement: 0
          }
        },
        null
      );
      return result.candidates
        .filter((candidate) => candidate.admissionPlanes?.includes("activation") === true)
        .map((candidate) => candidate.entry.content)
        .sort();
    };

    const firstReplay = await selectContents(replayA);
    expect(firstReplay).toEqual(["Alpha tied memory.", "Bravo tied memory."]);
    expect(await selectContents(replayB)).toEqual(firstReplay);
  });
});
