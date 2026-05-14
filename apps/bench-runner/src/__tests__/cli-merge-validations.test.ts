import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { runCli } from "../cli.js";

// @anchor merge-validation-tests — see apps/bench-runner/src/cli.ts
// @anchor merge-shard-validations. Each test sets up two shard roots
// containing minimally-valid kpi.json files and invokes the
// merge-longmemeval subcommand. The merge must reject incompatible
// shards BEFORE any per_scenario aggregation runs.

function makeShardKpi(overrides: Partial<KpiPayload> = {}): KpiPayload {
  return {
    bench_name: "public",
    split: "longmemeval-s",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "abc1234",
    alaya_version: "0.3.6",
    embedding_provider: "none",
    chat_provider: "none",
    dataset: {
      name: "longmemeval_s",
      size: 500,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    },
    sample_size: 500,
    evaluated_count: 5,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.6,
      r_at_5: 0.8,
      r_at_10: 0.9,
      latency_ms_p50: 10,
      latency_ms_p95: 20,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: 0, warm: 5, cold: 0 },
      degradation_reasons: {
        none: 5,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: [
        { id: "q-shard-default-1", version: 1, hit_at_5: true, tier: "warm" }
      ]
    },
    ...overrides
  };
}

async function writeShardRoot(root: string, kpi: KpiPayload): Promise<void> {
  const slug = "2026-05-14T100000Z-" + kpi.alaya_commit;
  const entryRoot = path.join(root, "public", slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(
    path.join(entryRoot, "kpi.json"),
    JSON.stringify(kpi, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(entryRoot, "report.md"), "report\n", "utf8");
  await writeFile(
    path.join(root, "public", "latest-baseline.json"),
    JSON.stringify({ slug, kpi_path: `${slug}/kpi.json` }, null, 2) + "\n",
    "utf8"
  );
}

describe("merge-longmemeval validations", () => {
  let tmpRoot: string;
  let originalWrite: typeof process.stderr.write;
  let stderrBuf: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "merge-validations-"));
    stderrBuf = "";
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = originalWrite;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("refuses shards whose split differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "0000aaa" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        split: "longmemeval-oracle",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/split=longmemeval-oracle.*split=longmemeval-s/);
  });

  it("refuses shards whose dataset identity differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "0000aaa" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        dataset: {
          name: "longmemeval_s_tampered",
          size: 500,
          source: "https://example.com/fake"
        },
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/dataset identity/);
  });

  it("refuses shards whose duplicate question ids overlap", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const dupId = "q-collide";
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "0000aaa",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: dupId, version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: dupId, version: 1, hit_at_5: false, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/duplicate question_id 'q-collide'/);
  });

  it("refuses shards whose evaluated_total exceeds dataset sample_size", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "0000aaa",
        sample_size: 10,
        evaluated_count: 8,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "qA-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        sample_size: 10,
        evaluated_count: 8,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "qB-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/evaluated_total=16 > sample_size=10/);
  });
});
