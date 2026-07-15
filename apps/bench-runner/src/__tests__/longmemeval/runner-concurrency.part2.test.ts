import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeShardRoot } from "../cli/cli-merge-validations-fixture.js";
import { writeShardEvidenceBundle } from "../cli/cli-merge-evidence-fixture.js";
import { createMergeDatasetSource } from
  "../cli/cli-merge-dataset-fixture.js";
import {
  runLongMemEvalConcurrent,
  type LongMemEvalWorkerSpawnOptions
} from "../../longmemeval/runner-concurrency.js";
import {
  makeRangeDiagnostics,
  makeRangeKpi,
  makeShardProvenance
} from "./runner-concurrency-fixture.js";

type ConcurrentRunResult = Awaited<ReturnType<typeof runLongMemEvalConcurrent>>;

async function writeSuccessfulShard(
  options: LongMemEvalWorkerSpawnOptions,
  spawnCalls: LongMemEvalWorkerSpawnOptions[]
): Promise<number> {
  spawnCalls.push(options);
  const offset = Number(options.args[options.args.indexOf("--offset") + 1]);
  const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
  const shardRoot = options.args[options.args.indexOf("--history-root") + 1];
  if (shardRoot === undefined) throw new Error("missing --history-root in worker args");
  const kpi = makeRangeKpi(offset, limit);
  const diagnostics = makeRangeDiagnostics(offset, limit);
  const provenance = makeShardProvenance(offset, limit);
  await writeShardRoot(shardRoot, kpi, diagnostics);
  await writeFile(
    join(shardRoot, "public", "2026-05-14T100000Z-abc1234", "longmemeval-run-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8"
  );
  await writeShardEvidenceBundle(shardRoot, kpi, diagnostics, provenance);
  return 0;
}

function assertWorkerSpawns(spawnCalls: readonly LongMemEvalWorkerSpawnOptions[]): void {
  expect(spawnCalls).toHaveLength(2);
  expect(spawnCalls[0]?.args).not.toContain("--concurrency");
  for (const call of spawnCalls) {
    const shardHistoryRoot = call.args[call.args.indexOf("--history-root") + 1];
    expect(call.env.ALAYA_BENCH_ARTIFACT_ROOT).toBe(
      join(shardHistoryRoot as string, ".bench-artifacts")
    );
    expect(call.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT).toBeUndefined();
  }
}

async function assertMergedArchive(
  result: ConcurrentRunResult,
  historyRoot: string
): Promise<void> {
  expect(result.payload.evaluated_count).toBe(4);
  expect(result.kpiPath).toContain(historyRoot);
  expect(result.diagnosticsPath).not.toBeNull();
  const archiveRoot = dirname(result.kpiPath);
  await expect(readFile(
    join(archiveRoot, "longmemeval-run-provenance.shard-0.json"), "utf8"
  )).resolves.toContain(`"offset": 0`);
  await expect(readFile(
    join(archiveRoot, "longmemeval-run-provenance.shard-1.json"), "utf8"
  )).resolves.toContain(`"offset": 2`);
  const aggregate = JSON.parse(await readFile(
    join(archiveRoot, "longmemeval-run-provenance.json"), "utf8"
  )) as Record<string, unknown>;
  expect(aggregate).toMatchObject({
    kind: "longmemeval_sharded_run_provenance",
    gate_eligible: true,
    requested_concurrency: 2,
    effective_concurrency: 2
  });
  const aggregateBytes = await readFile(join(archiveRoot, "longmemeval-run-provenance.json"));
  const manifest = JSON.parse(await readFile(
    join(archiveRoot, "longmemeval-evidence-manifest.json"), "utf8"
  )) as { artifacts: Array<{ role: string; sha256: string }> };
  expect(manifest.artifacts.find((artifact) => artifact.role === "run_provenance")?.sha256)
    .toBe(createHash("sha256").update(aggregateBytes).digest("hex"));
}

async function writeStatusOneShard(
  options: LongMemEvalWorkerSpawnOptions
): Promise<number> {
  const offset = Number(options.args[options.args.indexOf("--offset") + 1]);
  const limit = Number(options.args[options.args.indexOf("--limit") + 1]);
  const shardRoot = options.args[options.args.indexOf("--history-root") + 1];
  if (shardRoot === undefined) throw new Error("missing --history-root in worker args");
  await writeShardRoot(
    shardRoot,
    makeRangeKpi(offset, limit),
    makeRangeDiagnostics(offset, limit)
  );
  const provenance = makeShardProvenance(offset, limit);
  const { coverage: _coverage, ...cacheWithoutCoverage } = provenance.extraction_cache!;
  await writeFile(
    join(shardRoot, "public", "2026-05-14T100000Z-abc1234", "longmemeval-run-provenance.json"),
    `${JSON.stringify({ ...provenance, extraction_cache: cacheWithoutCoverage })}\n`,
    "utf8"
  );
  return offset === 0 ? 1 : 0;
}

let tmpRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lme-concurrency-"));
  const dataset = await createMergeDatasetSource(tmpRoot);
  dataDir = dirname(dataset.sourcePath);
  pinnedMetaRoot = dirname(dataset.checksumSourcePath);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("runLongMemEvalConcurrent", () => {
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
        spawnWorker: (options) => writeSuccessfulShard(options, spawnCalls)
      }
    );

    assertWorkerSpawns(spawnCalls);
    await assertMergedArchive(result, historyRoot);
  });
});

describe("runLongMemEvalConcurrent", () => {
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
        spawnWorker: writeStatusOneShard
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
});

describe("runLongMemEvalConcurrent", () => {
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
});

describe("runLongMemEvalConcurrent", () => {
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
});

describe("runLongMemEvalConcurrent", () => {
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
});

describe("runLongMemEvalConcurrent", () => {
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
