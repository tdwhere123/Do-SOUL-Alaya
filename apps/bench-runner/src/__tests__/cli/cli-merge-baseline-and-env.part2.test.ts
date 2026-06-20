import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../cli/index.js";

import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  makeShardDiagnostics,
  makeShardKpi,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("merge-longmemeval baseline and env aggregation", () => {

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

  it("refuses shards whose evaluated_total exceeds dataset sample_size", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
        sample_size: 10,
        evaluated_count: 8,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [{ id: "qA-1", version: 1, hit_at_5: true, tier: "warm" }]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        sample_size: 10,
        evaluated_count: 8,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [{ id: "qB-1", version: 1, hit_at_5: true, tier: "warm" }]
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

  it("merges env provider-rate KPIs by evaluated count and cache rates by cache counts", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const rowsA = Array.from({ length: 5 }, (_, index) => ({
      id: `qA-${index + 1}`,
      version: 1,
      hit_at_5: index < 4,
      tier: "warm" as const
    }));
    const rowsB = Array.from({ length: 5 }, (_, index) => ({
      id: `qB-${index + 1}`,
      version: 1,
      hit_at_5: index < 3,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
        embedding_provider: "yunwu:text-embedding-3-small",
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.8,
          r_at_5_overall: 0.8,
          r_at_5_with_embedding_returned: 2 / 3,
          provider_returned_rate: 3 / 5,
          provider_pending_rate: 1 / 5,
          provider_failed_rate: 1 / 5,
          embedding_vector_cache_ready_rate: 1,
          query_embedding_cache_ready_rate: 1,
          per_scenario: rowsA
        }
      }),
      makeShardDiagnostics({
        embedding_provider: "yunwu:text-embedding-3-small",
        embedding_mode: "env",
        embedding_vector_cache: {
          expected_count: 50,
          ready_count: 50,
          not_ready_count: 0,
          ready_rate: 1,
          max_pass_count: 2
        },
        query_embedding_cache: {
          requested_count: 5,
          ready_count: 5,
          not_ready_count: 0,
          ready_rate: 1,
          cache_hit_count: 0,
          provider_requested_count: 5
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        embedding_provider: "yunwu:text-embedding-3-small",
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.6,
          r_at_5_overall: 0.6,
          r_at_5_with_embedding_returned: 1,
          provider_returned_rate: 2 / 5,
          provider_pending_rate: 2 / 5,
          provider_failed_rate: 1 / 5,
          embedding_vector_cache_ready_rate: 1,
          query_embedding_cache_ready_rate: 1,
          per_scenario: rowsB
        }
      }),
      makeShardDiagnostics({
        embedding_provider: "yunwu:text-embedding-3-small",
        embedding_mode: "env",
        embedding_vector_cache: {
          expected_count: 100,
          ready_count: 0,
          not_ready_count: 100,
          ready_rate: 0,
          max_pass_count: 3
        },
        query_embedding_cache: {
          requested_count: 15,
          ready_count: 0,
          not_ready_count: 15,
          ready_rate: 0,
          cache_hit_count: 1,
          provider_requested_count: 14
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
    expect(merged.kpi.r_at_5).toBe(0.7);
    expect(merged.kpi.r_at_5_overall).toBe(0.7);
    expect(merged.kpi.provider_returned_rate).toBe(0.5);
    expect(merged.kpi.provider_pending_rate).toBe(0.3);
    expect(merged.kpi.provider_failed_rate).toBe(0.2);
    expect(merged.kpi.r_at_5_with_embedding_returned).toBe(0.8);
    expect(merged.kpi.embedding_vector_cache_ready_rate).toBe(50 / 150);
    expect(merged.kpi.query_embedding_cache_ready_rate).toBe(5 / 20);

    const diagnostics = JSON.parse(
      await readFile(
        path.join(
          historyRoot,
          "public",
          pointer.slug,
          LONGMEMEVAL_DIAGNOSTICS_FILENAME
        ),
        "utf8"
      )
    ) as {
      embedding_vector_cache?: { expected_count: number; max_pass_count: number };
      query_embedding_cache?: {
        requested_count: number;
        ready_count: number;
        cache_hit_count: number;
        provider_requested_count: number;
      };
    };
    expect(diagnostics.embedding_vector_cache).toMatchObject({
      expected_count: 150,
      ready_count: 50,
      max_pass_count: 3
    });
    expect(diagnostics.query_embedding_cache).toMatchObject({
      requested_count: 20,
      ready_count: 5,
      cache_hit_count: 1,
      provider_requested_count: 19
    });
  });
});
