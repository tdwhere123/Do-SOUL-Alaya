import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  runLongMemEvalConcurrent,
  type LongMemEvalWorkerSpawnOptions
} from "../../longmemeval/runner-concurrency.js";
import {
  makeRangeDiagnostics,
  makeRangeKpi,
  makeShardProvenance
} from "./runner-concurrency-fixture.js";

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
          await writeFile(
            join(
              shardRoot,
              "public",
              "2026-05-14T100000Z-abc1234",
              "longmemeval-run-provenance.json"
            ),
            `${JSON.stringify(makeShardProvenance(offset, limit), null, 2)}\n`,
            "utf8"
          );
          return 0;
        }
      }
    );

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.args).not.toContain("--concurrency");
    for (const call of spawnCalls) {
      const shardHistoryRoot = call.args[call.args.indexOf("--history-root") + 1];
      expect(call.env.ALAYA_BENCH_ARTIFACT_ROOT).toBe(
        join(shardHistoryRoot as string, ".bench-artifacts")
      );
      expect(call.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT).toBeUndefined();
    }
    expect(result.payload.evaluated_count).toBe(4);
    expect(result.kpiPath).toContain(historyRoot);
    expect(result.diagnosticsPath).not.toBeNull();
    const archiveRoot = dirname(result.kpiPath);
    await expect(readFile(
      join(archiveRoot, "longmemeval-run-provenance.shard-0.json"),
      "utf8"
    )).resolves.toContain(`"offset": 0`);
    await expect(readFile(
      join(archiveRoot, "longmemeval-run-provenance.shard-1.json"),
      "utf8"
    )).resolves.toContain(`"offset": 2`);
    const aggregate = JSON.parse(await readFile(
      join(archiveRoot, "longmemeval-run-provenance.json"),
      "utf8"
    )) as Record<string, unknown>;
    expect(aggregate).toMatchObject({
      kind: "longmemeval_sharded_run_provenance",
      gate_eligible: true,
      requested_concurrency: 2,
      effective_concurrency: 2
    });
    const aggregateBytes = await readFile(
      join(archiveRoot, "longmemeval-run-provenance.json")
    );
    const manifest = JSON.parse(await readFile(
      join(archiveRoot, "longmemeval-evidence-manifest.json"),
      "utf8"
    )) as { artifacts: Array<{ role: string; sha256: string }> };
    expect(manifest.artifacts.find((artifact) => artifact.role === "run_provenance")?.sha256)
      .toBe(createHash("sha256").update(aggregateBytes).digest("hex"));
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
          const provenance = makeShardProvenance(offset, limit);
          const { coverage: _coverage, ...cacheWithoutCoverage } = provenance.extraction_cache!;
          await writeFile(
            join(shardRoot, "public", "2026-05-14T100000Z-abc1234", "longmemeval-run-provenance.json"),
            `${JSON.stringify({
              ...provenance,
              extraction_cache: cacheWithoutCoverage
            })}\n`,
            "utf8"
          );
          return offset === 0 ? 1 : 0;
        }
      }
    );

    expect(result.payload.evaluated_count).toBe(4);
    expect(result.kpiPath).toContain(historyRoot);
    expect(result.diagnosticsPath).not.toBeNull();
    const aggregate = JSON.parse(await readFile(
      join(dirname(result.kpiPath), "longmemeval-run-provenance.json"),
      "utf8"
    )) as { gate_eligible: boolean };
    expect(aggregate.gate_eligible).toBe(false);
  });

  it("fails the concurrent run when a worker exits without mergeable evidence", async () => {
    await expect(runLongMemEvalConcurrent(
      {
        variant: "longmemeval_s",
        limit: 4,
        historyRoot: join(tmpRoot, "fatal-worker-history"),
        dataDir,
        pinnedMetaRoot,
        concurrency: 2
      },
      { spawnWorker: async () => 2 }
    )).rejects.toThrow(/worker processes failed \(2,2\)/u);
  });

  it("fails loud when a present shard provenance sidecar is malformed", async () => {
    await expect(runLongMemEvalConcurrent(
      {
        variant: "longmemeval_s",
        limit: 4,
        historyRoot: join(tmpRoot, "invalid-provenance-history"),
        dataDir,
        pinnedMetaRoot,
        concurrency: 2
      },
      {
        spawnWorker: async (options) => {
          const offset = Number(options.args[options.args.indexOf("--offset") + 1]);
          const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
          const shardRoot = options.args[options.args.indexOf("--history-root") + 1]!;
          await writeShardRoot(
            shardRoot,
            makeRangeKpi(offset, limit),
            makeRangeDiagnostics(offset, limit)
          );
          await writeFile(
            join(shardRoot, "public", "2026-05-14T100000Z-abc1234", "longmemeval-run-provenance.json"),
            offset === 0 ? "{}\n" : `${JSON.stringify(makeShardProvenance(offset, limit))}\n`,
            "utf8"
          );
          return 0;
        }
      }
    )).rejects.toThrow(/invalid shard run provenance/u);
  });

  it("fails loud when parsed shard provenance identities disagree", async () => {
    await expect(runLongMemEvalConcurrent(
      {
        variant: "longmemeval_s",
        limit: 4,
        historyRoot: join(tmpRoot, "incoherent-provenance-history"),
        dataDir,
        pinnedMetaRoot,
        concurrency: 2
      },
      {
        spawnWorker: async (options) => {
          const offset = Number(options.args[options.args.indexOf("--offset") + 1]);
          const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
          const shardRoot = options.args[options.args.indexOf("--history-root") + 1]!;
          await writeShardRoot(
            shardRoot,
            makeRangeKpi(offset, limit),
            makeRangeDiagnostics(offset, limit)
          );
          const base = makeShardProvenance(offset, limit);
          const provenance = offset === 0 ? base : {
            ...base,
            runtime: {
              ...base.runtime,
              paired_env: { ...base.runtime.paired_env, ALAYA_RECALL_CONF_RHO_PATH: "drift" }
            }
          };
          await writeFile(
            join(shardRoot, "public", "2026-05-14T100000Z-abc1234", "longmemeval-run-provenance.json"),
            `${JSON.stringify(provenance)}\n`,
            "utf8"
          );
          return 0;
        }
      }
    )).rejects.toThrow(/run provenance is incoherent/u);
  });

  it("validates shard execution plans before publishing the merged archive", async () => {
    const historyRoot = join(tmpRoot, "shifted-plan-history");
    await expect(runLongMemEvalConcurrent(
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
          const offset = Number(options.args[options.args.indexOf("--offset") + 1]);
          const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
          const shardRoot = options.args[options.args.indexOf("--history-root") + 1]!;
          await writeShardRoot(
            shardRoot,
            makeRangeKpi(offset, limit),
            makeRangeDiagnostics(offset, limit)
          );
          await writeFile(
            join(shardRoot, "public", "2026-05-14T100000Z-abc1234", "longmemeval-run-provenance.json"),
            `${JSON.stringify(makeShardProvenance(offset + 1, limit))}\n`,
            "utf8"
          );
          return 0;
        }
      }
    )).rejects.toThrow(/execution provenance mismatch/u);
    await expect(access(join(historyRoot, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
