import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeShardDiagnostics,
  makeShardKpi,
  writeShardRoot
} from "../cli/cli-merge-validations-fixture.js";
import {
  buildLongMemEvalFixtureQuestion,
  writeLongMemEvalFixtureDataset
} from "./longmemeval-fixture.js";
import {
  buildLongMemEvalWorkerShardPlans,
  runLongMemEvalConcurrent,
  validateLongMemEvalConcurrency,
  type LongMemEvalWorkerSpawnOptions
} from "../../longmemeval/runner-concurrency.js";

describe("buildLongMemEvalWorkerShardPlans", () => {
  it("splits the window evenly across process-backed workers", () => {
    const shardRoot = join(tmpdir(), "lme-shards");
    const plans = buildLongMemEvalWorkerShardPlans({
      windowLength: 10,
      baseOffset: 5,
      concurrency: 3,
      shardRoot
    });

    expect(plans).toEqual([
      {
        shardIndex: 0,
        offset: 5,
        limit: 4,
        historyRoot: join(shardRoot, "shard-0")
      },
      {
        shardIndex: 1,
        offset: 9,
        limit: 4,
        historyRoot: join(shardRoot, "shard-1")
      },
      {
        shardIndex: 2,
        offset: 13,
        limit: 2,
        historyRoot: join(shardRoot, "shard-2")
      }
    ]);
  });
});

describe("validateLongMemEvalConcurrency", () => {
  it("refuses unsupported flag combinations loudly", () => {
    expect(() =>
      validateLongMemEvalConcurrency({
        variant: "longmemeval_s",
        historyRoot: "/tmp/history",
        concurrency: 2,
        snapshotOut: "/tmp/snapshot.db"
      })
    ).toThrow(/--concurrency > 1 is incompatible with --snapshot-out/);

    expect(() =>
      validateLongMemEvalConcurrency({
        variant: "longmemeval_s",
        historyRoot: "/tmp/history",
        concurrency: 2,
        dataDirRoot: "/tmp/db"
      })
    ).toThrow(/--concurrency > 1 is incompatible with --data-dir-root/);

    expect(() =>
      validateLongMemEvalConcurrency({
        variant: "longmemeval_s",
        historyRoot: "/tmp/history",
        concurrency: 2,
        qa: {
          chat: async () => "answer",
          answerModel: "test",
          judgeModel: "test"
        }
      })
    ).toThrow(/--concurrency > 1 is incompatible with --qa/);
  });
});

describe("runLongMemEvalConcurrent", () => {
  let tmpRoot: string;
  let dataDir: string;
  let pinnedMetaRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "lme-concurrency-"));
    dataDir = join(tmpRoot, "data");
    pinnedMetaRoot = join(tmpRoot, "pinned");
    await mkdir(dataDir, { recursive: true });
    await mkdir(pinnedMetaRoot, { recursive: true });
    const questions = [
      buildLongMemEvalFixtureQuestion("q-1", "s-1"),
      buildLongMemEvalFixtureQuestion("q-2", "s-2"),
      buildLongMemEvalFixtureQuestion("q-3", "s-3"),
      buildLongMemEvalFixtureQuestion("q-4", "s-4")
    ];
    await writeLongMemEvalFixtureDataset({
      variant: "longmemeval_s",
      dataDir,
      pinnedMetaRoot,
      questions
    });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("launches one worker per shard and merges shard archives", async () => {
    const historyRoot = join(tmpRoot, "merged-history");
    const spawnCalls: LongMemEvalWorkerSpawnOptions[] = [];

    const result = await runLongMemEvalConcurrent(
      {
        variant: "longmemeval_s",
        limit: 4,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        concurrency: 2
      },
      {
        spawnWorker: async (options) => {
          spawnCalls.push(options);
          const offset = Number(
            options.args[options.args.indexOf("--offset") + 1]
          );
          const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
          const shardRoot = options.args[options.args.indexOf("--history-root") + 1];
          if (shardRoot === undefined) {
            throw new Error("missing --history-root in worker args");
          }
          await writeShardRoot(
            shardRoot,
            makeShardKpi({
              evaluated_count: limit,
              kpi: {
                ...makeShardKpi().kpi,
                per_scenario: Array.from({ length: limit }, (_, index) => ({
                  id: `q-${offset + index + 1}`,
                  version: 1,
                  hit_at_5: true,
                  tier: "warm" as const
                }))
              }
            })
          );
          return 0;
        }
      }
    );

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.args).not.toContain("--concurrency");
    for (const call of spawnCalls) {
      const shardRoot = call.args[call.args.indexOf("--history-root") + 1];
      expect(call.env.ALAYA_BENCH_ARTIFACT_ROOT).toBe(
        join(shardRoot as string, ".bench-artifacts")
      );
    }
    expect(result.payload.evaluated_count).toBe(4);
    expect(result.kpiPath).toContain(historyRoot);
    expect(result.diagnosticsPath).not.toBeNull();
  });

  it("still merges shard archives when a worker exits 1 after writing KPI evidence", async () => {
    const historyRoot = join(tmpRoot, "merged-history-status-1");

    const result = await runLongMemEvalConcurrent(
      {
        variant: "longmemeval_s",
        limit: 4,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        concurrency: 2
      },
      {
        spawnWorker: async (options) => {
          const offset = Number(
            options.args[options.args.indexOf("--offset") + 1]
          );
          const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
          const shardRoot = options.args[options.args.indexOf("--history-root") + 1];
          if (shardRoot === undefined) {
            throw new Error("missing --history-root in worker args");
          }
          await writeShardRoot(
            shardRoot,
            makeShardKpi({
              evaluated_count: limit,
              kpi: {
                ...makeShardKpi().kpi,
                per_scenario: Array.from({ length: limit }, (_, index) => ({
                  id: `q-${offset + index + 1}`,
                  version: 1,
                  hit_at_5: true,
                  tier: "warm" as const
                }))
              }
            }),
            makeShardDiagnostics({
              questions: Array.from({ length: limit }, (_, index) => ({
                question_id: `q-${offset + index + 1}`,
                gold_memory_ids: [`gold-${offset + index + 1}`],
                delivered_memory_ids: [`delivered-${offset + index + 1}`],
                delivered_gold_ids: [`gold-${offset + index + 1}`],
                miss_reasons: [],
                provider_state: "provider_not_requested"
              }))
            })
          );
          return offset === 0 ? 1 : 0;
        }
      }
    );

    expect(result.payload.evaluated_count).toBe(4);
    expect(result.kpiPath).toContain(historyRoot);
    expect(result.diagnosticsPath).not.toBeNull();
  });
});
