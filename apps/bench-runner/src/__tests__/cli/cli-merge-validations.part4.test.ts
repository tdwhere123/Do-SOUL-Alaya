import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import {
  makeShardKpi,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("merge-longmemeval scalar identity validations", () => {
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
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "0000bbb",
      split: "longmemeval-oracle",
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }]
      }
    }));
    const exitCode = await merge(shardA, shardB);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/split=longmemeval-oracle.*split=longmemeval-s/);
  });

  it("refuses shards whose sample_size differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({
      alaya_commit: "0000aaa", sample_size: 500, evaluated_count: 5
    }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "0000bbb",
      sample_size: 250,
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }]
      }
    }));
    const exitCode = await merge(shardA, shardB);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/sample_size=250 != shard\[0\] sample_size=500/);
  });

  it("refuses shards whose dataset identity differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "abc1234" }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "abc1234",
      dataset: { name: "longmemeval_s_tampered", size: 500, source: "https://example.com/fake" },
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }]
      }
    }));
    const exitCode = await merge(shardA, shardB);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/dataset identity/);
  });

  it("refuses shards whose duplicate question ids overlap", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({
      alaya_commit: "abc1234",
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-collide", version: 1, hit_at_5: true, tier: "warm" }]
      }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "abc1234",
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-collide", version: 1, hit_at_5: false, tier: "warm" }]
      }
    }));
    const exitCode = await merge(shardA, shardB);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/duplicate question_id 'q-collide'/);
  });

  it("refuses shards whose harness_mode differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({
      alaya_commit: "0000aaa", harness_mode: "mcp_propose_review"
    }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "0000bbb",
      harness_mode: "direct_db_seed",
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }]
      }
    }));
    const exitCode = await merge(shardA, shardB);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(
      /harness_mode=direct_db_seed != shard\[0\] harness_mode=mcp_propose_review/
    );
  });

  it("refuses shards whose embedding_provider differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({
      alaya_commit: "0000aaa", embedding_provider: "none"
    }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "0000bbb",
      embedding_provider: "yunwu:text-embedding-3-small",
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }]
      }
    }));
    const exitCode = await merge(shardA, shardB);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(
      /embedding_provider=yunwu:text-embedding-3-small != shard\[0\] embedding_provider=none/
    );
  });

  function merge(shardA: string, shardB: string): Promise<number> {
    return runCli([
      "merge-longmemeval", "--variant", "s", "--history-root",
      path.join(tmpRoot, "history"), "--shards", shardA, shardB
    ]);
  }
});
