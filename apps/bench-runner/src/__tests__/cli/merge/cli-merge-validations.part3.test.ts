import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../../cli/index.js";

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

  it("refuses shards whose chat_provider differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", chat_provider: "none" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        chat_provider: "yunwu:gpt-5.4-mini",
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
      /chat_provider=yunwu:gpt-5.4-mini != shard\[0\] chat_provider=none/
    );
  });

  it("refuses shards whose policy_shape differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "abc1234", policy_shape: "stress" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
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
      /policy_shape=chat != shard\[0\] policy_shape=stress/
    );
  });

  it("refuses shards whose simulate_report mode differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "abc1234", simulate_report: "none" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        simulate_report: "mixed",
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
      /simulate_report=mixed != shard\[0\] simulate_report=none/
    );
  });

  it("refuses shards whose seed policy differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "abc1234" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        seed_policy: {
          mode: "rotating_object_kind",
          label_independent: true
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
    expect(stderrBuf).toMatch(/seed_policy differs from shard\[0\]/);
  });

  it("refuses shards whose recall weight overrides differ", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
        recall_weight_overrides: {
          source: "cli",
          fusion_weights: { lexical_fts: 0.5 }
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        recall_weight_overrides: {
          source: "cli",
          fusion_weights: { lexical_fts: 0.6 }
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
    expect(stderrBuf).toMatch(/recall_weight_overrides != shard\[0\] recall_weight_overrides/);
  });
});
