import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry, PathRelation } from "@do-soul/alaya-protocol";
import {
  expandGraphFrontier,
  expandGraphFrontiersBySeed
} from "../../recall/expansion/structural-expansion-graph-frontier.js";
import type { GraphExpansionCandidateDraft } from "../../recall/expansion/graph-expansion.js";
import type { RecallServicePathExpansionPort } from "../../recall/runtime/recall-service-ports.js";
import {
  createMemoryEntry,
  createPathRelation
} from "./recall-service-test-fixtures.js";

type CandidateView = Readonly<{
  readonly id: string;
  readonly score: number;
  readonly hop: number;
  readonly edgeType: string;
}>;

type PathReader = RecallServicePathExpansionPort["findByAnchors"];
type PathReaderMock = ReturnType<typeof vi.fn<PathReader>>;

describe("batched entity-seed graph frontier", () => {
  it("matches independent traversals across mixed randomized path semantics", async () => {
    const entries = Array.from({ length: 14 }, (_, index) =>
      createMemoryEntry({ object_id: `memory-${index}` })
    );
    const seeds = entries.slice(0, 4);
    const paths = buildDeterministicMixedPaths(entries);

    const serial = await runSerial(entries, seeds, paths);
    const batched = await runBatched(entries, seeds, paths);

    expect(batched.candidates).toEqual(serial.candidates);
  });

  it("preserves directed, unordered-kind, self-loop, negative, inactive, and two-hop behavior", async () => {
    const entries = ["alpha", "beta", "middle", "leaf", "reverse", "ignored"]
      .map((object_id) => createMemoryEntry({ object_id }));
    const seeds = entries.slice(0, 2);
    const paths = [
      path("forward", "alpha", "middle", "supports"),
      path("second-hop", "middle", "leaf", "derives_from"),
      path("reverse-only", "reverse", "beta", "shares_entity", {
        directionBias: "target_to_source"
      }),
      path("unordered-kind", "beta", "leaf", "co_recalled", {
        directionBias: "bidirectional_asymmetric"
      }),
      path("self-loop", "alpha", "alpha", "supports"),
      path("negative", "alpha", "ignored", "supports", { recallBias: -1 }),
      path("inactive", "beta", "ignored", "supports", { status: "dormant" })
    ];

    const serial = await runSerial(entries, seeds, paths);
    const batched = await runBatched(entries, seeds, paths);

    expect(batched.candidates).toEqual(serial.candidates);
    expect(batched.candidates[0]?.map((candidate) => candidate.id)).toEqual(["middle", "leaf"]);
    expect(batched.candidates[1]?.map((candidate) => candidate.id)).toEqual(["reverse", "leaf"]);
  });

  it("performs one path read per active hop instead of one per seed and hop", async () => {
    const entries = ["seed-a", "seed-b", "seed-c", "mid-a", "mid-b", "mid-c", "leaf-a", "leaf-b", "leaf-c"]
      .map((object_id) => createMemoryEntry({ object_id }));
    const seeds = entries.slice(0, 3);
    const paths = seeds.flatMap((seed, index) => [
      path(`hop-1-${index}`, seed.object_id, `mid-${String.fromCharCode(97 + index)}`, "supports"),
      path(`hop-2-${index}`, `mid-${String.fromCharCode(97 + index)}`, `leaf-${String.fromCharCode(97 + index)}`, "derives_from")
    ]);

    const serial = await runSerial(entries, seeds, paths);
    const batched = await runBatched(entries, seeds, paths);

    expect(batched.candidates).toEqual(serial.candidates);
    expect(serial.findByAnchors).toHaveBeenCalledTimes(6);
    expect(batched.findByAnchors).toHaveBeenCalledTimes(2);
  });

  it("preserves per-seed failure diagnostics while issuing one failed batch read", async () => {
    const entries = ["seed-a", "seed-b", "seed-c"]
      .map((object_id) => createMemoryEntry({ object_id }));
    const serialWarn = vi.fn();
    const serialDegradationReasons = new Set<"graph_expansion_failed">();
    const serialFindByAnchors = vi.fn<PathReader>(async () => {
      throw new Error("path read failed");
    });
    for (const seed of entries) {
      await expandGraphFrontier({
        ...traversalParams(entries, serialFindByAnchors),
        seedEntries: [seed],
        warn: serialWarn,
        degradationReasons: serialDegradationReasons,
        onCandidate: () => undefined
      });
    }

    const batchedWarn = vi.fn();
    const batchedDegradationReasons = new Set<"graph_expansion_failed">();
    const batchedFindByAnchors = vi.fn<PathReader>(async () => {
      throw new Error("path read failed");
    });

    await expandGraphFrontiersBySeed({
      workspaceId: "workspace-1",
      byId: new Map(entries.map((entry) => [entry.object_id, entry])),
      pathExpansionPort: { findByAnchors: batchedFindByAnchors },
      seedEntries: entries,
      maxGraphHops: 2,
      dynamicRecallEdgeFanout: 10,
      warn: batchedWarn,
      degradationReasons: batchedDegradationReasons,
      onCandidate: () => undefined
    });

    expect(serialFindByAnchors).toHaveBeenCalledTimes(3);
    expect(batchedFindByAnchors).toHaveBeenCalledTimes(4);
    expect(batchedWarn.mock.calls).toEqual(serialWarn.mock.calls);
    expect(batchedDegradationReasons).toEqual(serialDegradationReasons);
  });

  it("isolates a failed seed when batch fallback succeeds for other seeds", async () => {
    const entries = ["seed-a", "seed-b", "neighbor-a"]
      .map((object_id) => createMemoryEntry({ object_id }));
    const paths = [path("seed-a-neighbor", "seed-a", "neighbor-a", "supports")];
    const warn = vi.fn();
    const degradationReasons = new Set<"graph_expansion_failed">();
    const findByAnchors = vi.fn<PathReader>(async (_workspaceId, anchors) => {
      const ids = new Set(anchors.flatMap((anchor) =>
        anchor.kind === "object" ? [anchor.object_id] : []
      ));
      if (ids.size > 1) {
        throw new Error("batch read failed");
      }
      if (ids.has("seed-b")) {
        throw new Error("seed-b read failed");
      }
      return paths.filter((candidate) => pathTouchesAny(candidate, ids));
    });
    const candidates = entries.slice(0, 2).map((): CandidateView[] => []);

    await expandGraphFrontiersBySeed({
      ...traversalParams(entries, findByAnchors),
      seedEntries: entries.slice(0, 2),
      warn,
      degradationReasons,
      onCandidate: (seedIndex, candidate) => candidates[seedIndex]?.push(candidateView(candidate))
    });

    expect(candidates).toEqual([
      [{ id: "neighbor-a", score: 1, hop: 1, edgeType: "supports" }],
      []
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ seed_count: 1 });
    expect(degradationReasons).toEqual(new Set(["graph_expansion_failed"]));
  });
});

async function runSerial(
  entries: readonly MemoryEntry[],
  seeds: readonly MemoryEntry[],
  paths: readonly PathRelation[]
): Promise<Readonly<{ candidates: readonly CandidateView[][]; findByAnchors: PathReaderMock }>> {
  const findByAnchors = createPathReader(paths);
  const candidates: CandidateView[][] = [];
  for (const seed of seeds) {
    const seedCandidates: CandidateView[] = [];
    await expandGraphFrontier({
      ...traversalParams(entries, findByAnchors),
      seedEntries: [seed],
      onCandidate: (candidate) => seedCandidates.push(candidateView(candidate))
    });
    candidates.push(seedCandidates);
  }
  return { candidates, findByAnchors };
}

async function runBatched(
  entries: readonly MemoryEntry[],
  seeds: readonly MemoryEntry[],
  paths: readonly PathRelation[]
): Promise<Readonly<{ candidates: readonly CandidateView[][]; findByAnchors: PathReaderMock }>> {
  const findByAnchors = createPathReader(paths);
  const candidates = seeds.map((): CandidateView[] => []);
  await expandGraphFrontiersBySeed({
    ...traversalParams(entries, findByAnchors),
    seedEntries: seeds,
    onCandidate: (seedIndex, candidate) => candidates[seedIndex]?.push(candidateView(candidate))
  });
  return { candidates, findByAnchors };
}

function traversalParams(entries: readonly MemoryEntry[], findByAnchors: PathReader) {
  return {
    workspaceId: "workspace-1",
    byId: new Map(entries.map((entry) => [entry.object_id, entry])),
    pathExpansionPort: { findByAnchors },
    maxGraphHops: 2,
    dynamicRecallEdgeFanout: 10,
    warn: vi.fn()
  } as const;
}

function createPathReader(paths: readonly PathRelation[]) {
  return vi.fn<PathReader>(async (_workspaceId, anchors) => {
    const ids = new Set(anchors.flatMap((anchor) =>
      anchor.kind === "object" ? [anchor.object_id] : []
    ));
    return paths.filter((candidate) => pathTouchesAny(candidate, ids));
  });
}

function pathTouchesAny(pathRelation: PathRelation, ids: ReadonlySet<string>): boolean {
  const anchors = [pathRelation.anchors.source_anchor, pathRelation.anchors.target_anchor];
  return anchors.some((anchor) => anchor.kind === "object" && ids.has(anchor.object_id));
}

function candidateView(candidate: Readonly<GraphExpansionCandidateDraft>): CandidateView {
  return {
    id: candidate.entry.object_id,
    score: candidate.score,
    hop: candidate.hop,
    edgeType: candidate.edgeType
  };
}

function path(
  path_id: string,
  sourceId: string,
  targetId: string,
  relationKind: string,
  overrides: Parameters<typeof createPathRelation>[0] = {}
): PathRelation {
  return createPathRelation({ path_id, sourceId, targetId, relationKind, ...overrides });
}

function buildDeterministicMixedPaths(entries: readonly MemoryEntry[]): readonly PathRelation[] {
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const directions = ["source_to_target", "target_to_source", "bidirectional_asymmetric"] as const;
  const kinds = ["supports", "derives_from", "recalls", "co_recalled", "shares_entity"];
  const statuses = ["active", "active", "active", "dormant", "retired"] as const;
  return Array.from({ length: 60 }, (_, index) => {
    const sourceId = entries[next() % entries.length]?.object_id ?? "memory-0";
    const targetId = index % 11 === 0
      ? sourceId
      : entries[next() % entries.length]?.object_id ?? "memory-1";
    return path(`random-${index}`, sourceId, targetId, kinds[next() % kinds.length] ?? "supports", {
      directionBias: directions[next() % directions.length],
      recallBias: index % 9 === 0 ? -1 : index % 13 === 0 ? 0 : 1,
      status: statuses[next() % statuses.length]
    });
  });
}
