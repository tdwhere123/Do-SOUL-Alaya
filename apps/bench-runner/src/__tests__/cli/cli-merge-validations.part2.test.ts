import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../cli/index.js";

import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from "./cli-merge-validations-fixture.js";

import {
  makeQualityMetrics,
  makeShardDiagnostics,
  makeShardKpi,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

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

  it("fails closed when compact question_count is malformed", async () => {
    const shard = path.join(tmpRoot, "shard-malformed-question-count");
    await writeShardRoot(
      shard,
      makeShardKpi({
        policy_shape: "chat",
        simulate_report: "mixed",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1
        }
      }),
      makeShardDiagnostics({
        compact_schema_version: 1,
        question_count: "bad",
        questions: undefined,
        report_side_effects: undefined
      })
    );

    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      path.join(tmpRoot, "history-malformed-question-count"),
      "--shards",
      shard
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain(
      "invalid compact diagnostics question_count: expected non-negative integer"
    );
  });

  it("reports a clear error when a shard root has no usable pointer", async () => {
    const shard = path.join(tmpRoot, "shard-no-pointer");
    await mkdir(path.join(shard, "public"), { recursive: true });

    const historyRoot = path.join(tmpRoot, "history-no-pointer");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shard
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain(
      "no usable shard pointer; checked latest-passing.json, latest-run.json, latest-baseline.json"
    );
  });

  it("diffs merged public archives against the newest passing baseline", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-a-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history-baseline");
    const priorPassingRunAt = "2026-05-13T12:00:00.000Z";
    await writeHistoryEntry(
      historyRoot,
      "2026-05-13T120000Z-aaa1111-policy-stress",
      makeShardKpi({
        run_at: priorPassingRunAt,
        alaya_commit: "aaa1111",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.9
        }
      })
    );
    await writeHistoryEntry(
      historyRoot,
      "2026-05-13T130000Z-bbb2222-policy-stress",
      makeShardKpi({
        run_at: "2026-05-13T13:00:00.000Z",
        alaya_commit: "bbb2222",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.1
        }
      }),
      "# findings\n- regression\n"
    );

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

    expect(exitCode).toBe(0);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(merged.diff_vs_previous?.previous_run).toBe(priorPassingRunAt);
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

  it("refuses shards whose sample_size differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "0000aaa",
        sample_size: 500,
        evaluated_count: 5
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        sample_size: 250,
        evaluated_count: 5,
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
    expect(stderrBuf).toMatch(/sample_size=250 != shard\[0\] sample_size=500/);
  });

  it("refuses shards whose dataset identity differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    // Same alaya_commit so scalar-identity loop reaches the dataset
    // composite check (dataset is not in SCALAR_IDENTITY_FIELDS).
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "abc1234" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
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
    // Same alaya_commit for both shards so the new alaya_commit check
    // does not fire first; the test exercises the duplicate-id branch.
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
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
        alaya_commit: "abc1234",
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

  it("refuses shards whose harness_mode differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", harness_mode: "mcp_propose_review" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        harness_mode: "direct_db_seed",
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
    expect(stderrBuf).toMatch(
      /harness_mode=direct_db_seed != shard\[0\] harness_mode=mcp_propose_review/
    );
  });

  it("refuses shards whose embedding_provider differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", embedding_provider: "none" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        embedding_provider: "yunwu:text-embedding-3-small",
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
    expect(stderrBuf).toMatch(
      /embedding_provider=yunwu:text-embedding-3-small != shard\[0\] embedding_provider=none/
    );
  });
});
