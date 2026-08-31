import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import type { LongMemEvalSnapshotManifest } from "../../../runs/snapshot/materialize.js";
import { buildMergedLongMemEvalPayload } from "../../../cli/merge/command/merge-command-shards.js";
import {
  makeRangeDiagnostics,
  makeRangeKpi
} from "../runner/runner-concurrency-fixture.js";
import { writeShardRoot } from "../../cli/merge/cli-merge-validations-fixture.js";
import {
  REQUIRE_SLICE_REUSE_ENV,
  SEALED_SLICE_RESTORE_ENV
} from "../../../runs/snapshot/recall-eval/workspace-slice/index.js";
import {
  assertExactRecallEvalShardCoverage,
  buildMergedPerQuestionDelivered,
  resolveRecallEvalShardWindow,
  runRecallEvalSharded,
  validateRecallEvalConcurrency
} from "../../../runs/lifecycle/recall-eval/recall-eval-shards.js";
import { buildLongMemEvalWorkerShardPlans } from
  "../../../datasets/longmemeval/runner/runner-concurrency.js";
import {
  buildRecallEvalWorkerCliArgs,
  buildRecallEvalWorkerEnv
} from "../../../runs/lifecycle/recall-eval/recall-eval-shards-worker.js";
import type { LongMemEvalWorkerSpawnOptions } from
  "../../../datasets/longmemeval/runner/runner-concurrency-worker.js";

const PLANTED_HITS = [true, false, true, false] as const;

describe("validateRecallEvalConcurrency", () => {
  it("fails closed when --data-dir-root would be shared across shard workers", () => {
    expect(() => validateRecallEvalConcurrency({
      snapshotDbPath: "/tmp/snapshot.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/history",
      concurrency: 2,
      dataDirRoot: "/tmp/shared-db"
    })).toThrow(/--concurrency > 1 is incompatible with --data-dir-root/);
  });

  it.each([
    ["warm derived snapshot", { warmDerivedSnapshotReceiptPath: "/tmp/warm.json" }],
    ["derived projection rebuild", { derivedEvidenceProjectionRebuild: true }],
    ["embedding cache overlay", { embeddingCacheOverlayReceiptPath: "/tmp/overlay.json" }]
  ])("fails closed when sealed slices cannot represent %s", (_name, incompatible) => {
    expect(() => validateRecallEvalConcurrency({
      snapshotDbPath: "/tmp/snapshot.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/history",
      concurrency: 2,
      ...incompatible
    })).toThrow(/sealed slices cannot represent/u);
  });

  it("fails closed instead of sharing one memory profile across workers", () => {
    expect(() => validateRecallEvalConcurrency({
      snapshotDbPath: "/tmp/snapshot.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/history",
      concurrency: 2
    }, { ALAYA_RECALL_EVAL_MEMORY_PROFILE_PATH: "/tmp/profile.ndjson" }))
      .toThrow(/incompatible with memory profiling/u);
  });
});

describe("resolveRecallEvalShardWindow", () => {
  it("builds disjoint offset/limit coverage for two process shards", () => {
    const window = resolveRecallEvalShardWindow({ offset: 0, limit: 4 }, 4);
    const plans = buildLongMemEvalWorkerShardPlans({
      windowLength: window.windowLength,
      baseOffset: window.baseOffset,
      concurrency: 2,
      shardRoot: "/tmp/shards"
    });
    assertExactRecallEvalShardCoverage(plans, window.baseOffset, window.windowLength);
    expect(plans.map((plan) => ({ offset: plan.offset, limit: plan.limit }))).toEqual([
      { offset: 0, limit: 2 },
      { offset: 2, limit: 2 }
    ]);
  });
});
describe("buildRecallEvalWorkerCliArgs", () => {
  it("isolates each worker with offset/limit and omits shared data-dir-root", () => {
    const args = buildRecallEvalWorkerCliArgs({
      snapshotDbPath: "/tmp/snapshot.db",
      variant: "longmemeval_s",
      historyRoot: "/tmp/parent-history",
      dataDirRoot: "/tmp/must-not-forward",
      concurrency: 2
    }, {
      shardIndex: 1,
      offset: 2,
      limit: 2,
      historyRoot: "/tmp/shards/shard-1"
    });
    expect(args[0]).toBe("recall-eval");
    expect(args).not.toContain("--data-dir-root");
    expect(args).not.toContain("--concurrency");
    expect(args[args.indexOf("--offset") + 1]).toBe("2");
    expect(args[args.indexOf("--limit") + 1]).toBe("2");
    expect(args[args.indexOf("--history-root") + 1]).toBe("/tmp/shards/shard-1");
  });
});

describe("buildRecallEvalWorkerEnv", () => {
  it("requires sealed-slice restore so workers do not copy packed snapshots", () => {
    const env = buildRecallEvalWorkerEnv({
      concurrency: 2,
      embeddingMode: "disabled",
      shardRoot: "/tmp/shards",
      historyRoot: "/tmp/shards/shard-0"
    });
    expect(env[SEALED_SLICE_RESTORE_ENV]).toBe("1");
    expect(env[REQUIRE_SLICE_REUSE_ENV]).toBe("1");
  });

  it.each([
    ["disabled", "env"],
    ["env", "disabled"]
  ] as const)("pins explicit %s treatment over ambient %s", (explicit, ambient) => {
    const previous = process.env.ALAYA_RECALL_EVAL_EMBEDDING;
    process.env.ALAYA_RECALL_EVAL_EMBEDDING = ambient;
    try {
      const env = buildRecallEvalWorkerEnv({
        concurrency: 2,
        embeddingMode: explicit,
        shardRoot: "/tmp/shards",
        historyRoot: "/tmp/shards/shard-0"
      });
      expect(env.ALAYA_RECALL_EVAL_EMBEDDING).toBe(explicit);
    } finally {
      if (previous === undefined) delete process.env.ALAYA_RECALL_EVAL_EMBEDDING;
      else process.env.ALAYA_RECALL_EVAL_EMBEDDING = previous;
    }
  });
});

describe("buildMergedPerQuestionDelivered", () => {
  it("restores question and delivery order from validated shard diagnostics", () => {
    const delivered = buildMergedPerQuestionDelivered([
      { question_id: "q-2", delivered_results: [{ object_id: "b-1" }] },
      { question_id: "q-1", delivered_results: [
        { object_id: "a-1" },
        { object_id: "a-2" }
      ] }
    ], [{ id: "q-1" }, { id: "q-2" }]);

    expect([...delivered]).toEqual([
      ["q-1", ["a-1", "a-2"]],
      ["q-2", ["b-1"]]
    ]);
  });

  it("fails closed on missing or duplicate question diagnostics", () => {
    expect(() => buildMergedPerQuestionDelivered([
      { question_id: "q-1", delivered_results: [] },
      { question_id: "q-1", delivered_results: [] }
    ], [{ id: "q-1" }, { id: "q-2" }])).toThrow(/coverage/u);
  });
});

describe("planted two-shard merge identity", () => {
  it("unions question-level hits to match the serial fixture", () => {
    const serial = plantedKpi(0, 4, PLANTED_HITS);
    const merged = buildMergedLongMemEvalPayload({
      payloads: [
        plantedKpi(0, 2, PLANTED_HITS.slice(0, 2)),
        plantedKpi(2, 2, PLANTED_HITS.slice(2))
      ],
      archiveRefs: [],
      questionDiagnostics: [],
      first: plantedKpi(0, 2, PLANTED_HITS.slice(0, 2))
    });
    expect(questionHits(merged.payload)).toEqual(questionHits(serial));
    expect(merged.payload.kpi.seed_extraction_path?.llm_calls).toBe(0);
  });
});

describe("runRecallEvalSharded", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "recall-eval-shards-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("fails closed before spawn when dataDirRoot would be shared", async () => {
    let spawned = 0;
    await expect(runRecallEvalSharded({
      snapshotDbPath: join(tmpRoot, "snapshot.db"),
      variant: "longmemeval_s",
      historyRoot: join(tmpRoot, "history"),
      concurrency: 2,
      dataDirRoot: join(tmpRoot, "shared-db")
    }, {
      spawnWorker: async () => {
        spawned += 1;
        return 0;
      },
      resolveWindow: async () => ({ baseOffset: 0, windowLength: 4 }),
      loadSnapshotManifest: async () => stubManifest(4)
    })).rejects.toThrow(/--concurrency > 1 is incompatible with --data-dir-root/);
    expect(spawned).toBe(0);
  });

  it("merges planted two-shard question hits to match serial", async () => {
    const historyRoot = join(tmpRoot, "history");
    await mkdir(historyRoot, { recursive: true });
    const serial = plantedKpi(0, 4, PLANTED_HITS);
    const spawnCalls: LongMemEvalWorkerSpawnOptions[] = [];
    const result = await runRecallEvalSharded({
      snapshotDbPath: join(tmpRoot, "snapshot.db"),
      variant: "longmemeval_s",
      historyRoot,
      concurrency: 2,
      limit: 4
    }, {
      resolveWindow: async () => ({ baseOffset: 0, windowLength: 4 }),
      loadSnapshotManifest: async () => stubManifest(4),
      recordedGitState: {
        commitSha: "a".repeat(40),
        commitSha7: "aaaaaaa",
        worktreeStateSha256: "b".repeat(64),
        worktreeStateAlgorithm: "sha256-head-lf",
        worktreeClean: true
      },
      spawnWorker: async (options) => {
        spawnCalls.push(options);
        const offset = Number(options.args[options.args.indexOf("--offset") + 1]);
        const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
        const shardRoot = options.args[options.args.indexOf("--history-root") + 1];
        if (shardRoot === undefined) throw new Error("missing --history-root");
        const hits = PLANTED_HITS.slice(offset, offset + limit);
        await writeShardRoot(
          shardRoot,
          plantedKpi(offset, limit, hits),
          makeRangeDiagnostics(offset, limit)
        );
        return 0;
      }
    });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.args).not.toContain("--data-dir-root");
    expect(spawnCalls[0]?.args).not.toContain("--concurrency");
    expect(new Set(spawnCalls.map((call) => call.args[call.args.indexOf("--history-root") + 1])).size)
      .toBe(2);
    expect(spawnCalls.every((call) => call.env[SEALED_SLICE_RESTORE_ENV] === "1")).toBe(true);
    expect(questionHits(result.payload)).toEqual(questionHits(serial));
    expect(result.payload.kpi.seed_extraction_path?.llm_calls).toBe(0);
    expect(result.payload.evaluated_count).toBe(4);
  });

  it("aborts and joins a sibling when another shard spawn rejects", async () => {
    let siblingAborted = false;
    const run = runRecallEvalSharded({
      snapshotDbPath: join(tmpRoot, "snapshot.db"),
      variant: "longmemeval_s",
      historyRoot: join(tmpRoot, "history"),
      concurrency: 2,
      limit: 2
    }, {
      resolveWindow: async () => ({ baseOffset: 0, windowLength: 2 }),
      loadSnapshotManifest: async () => stubManifest(2),
      spawnWorker: async (options) => {
        const offset = Number(options.args[options.args.indexOf("--offset") + 1]);
        if (offset === 0) throw new Error("planted spawn failure");
        return await new Promise<number>((resolve) => {
          options.signal.addEventListener("abort", () => {
            siblingAborted = true;
            resolve(0);
          }, { once: true });
        });
      }
    });

    await expect(run).rejects.toThrow(/planted spawn failure/u);
    expect(siblingAborted).toBe(true);
  });
});

function plantedKpi(
  offset: number,
  limit: number,
  hits: readonly boolean[]
): KpiPayload {
  const base = makeRangeKpi(offset, limit);
  return {
    ...base,
    kpi: {
      ...base.kpi,
      per_scenario: base.kpi.per_scenario.map((row, index) => ({
        ...row,
        hit_at_5: hits[index] === true,
        hit_at_1: hits[index] === true
      }))
    }
  };
}

function questionHits(payload: KpiPayload): readonly {
  readonly id: string;
  readonly hit_at_5: boolean;
}[] {
  return [...payload.kpi.per_scenario]
    .map((row) => ({ id: row.id, hit_at_5: row.hit_at_5 }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function stubManifest(questionCount: number): LongMemEvalSnapshotManifest {
  return { question_count: questionCount } as LongMemEvalSnapshotManifest;
}
