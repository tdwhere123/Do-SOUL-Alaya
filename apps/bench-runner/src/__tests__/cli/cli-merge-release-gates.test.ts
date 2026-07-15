import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateSeedExtractionReleaseBlocker,
  type KpiPayload
} from "@do-soul/alaya-eval";

import { runCli } from "../../cli/index.js";

import {
  withEligibleMeasurementContract,
  makeQualityMetrics,
  makeSeedExtractionPath,
  makeShardDiagnostics,
  makeShardKpi,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("merge-longmemeval release gates", () => {

  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "merge-validations-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes policy-shape slugs without diffing an unverified matching baseline", async () => {
    const shard = path.join(tmpRoot, "shard-chat");
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `q-chat-${index + 1}`,
      version: 1,
      hit_at_5: index < 4,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shard,
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.8,
          per_scenario: rows
        }
      }),
      makeShardDiagnostics()
    );

    const historyRoot = path.join(tmpRoot, "history");
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100000Z-abc1234-policy-stress",
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "stress",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1
        }
      })
    );
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100001Z-abc1234-policy-chat",
      withEligibleMeasurementContract(makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.4
        }
      }))
    );
    await writeFile(
      path.join(historyRoot, "public", "latest-baseline.json"),
      JSON.stringify(
        {
          slug: "2026-05-14T100000Z-abc1234-policy-stress",
          kpi_path: "2026-05-14T100000Z-abc1234-policy-stress/kpi.json"
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shard
    ]);
    expect(exitCode).toBe(1);

    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    expect(pointer.slug).toMatch(/-policy-chat$/);

    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    const report = await readFile(
      path.join(historyRoot, "public", pointer.slug, "report.md"),
      "utf8"
    );
    expect(merged.policy_shape).toBe("chat");
    expect(merged.seed_policy?.mode).toBe("label_independent_all_fact");
    expect(report).toContain("Seed policy: label_independent_all_fact");
    expect(merged.diff_vs_previous).toBeNull();
    expect(report).toContain("_No previous baseline; this is the first entry._");
    expect(report).not.toContain("| r_at_5 | 1.0000 | 0.8000 |");
  });

  it("preserves merged seed extraction provenance and blocks degraded fallback evidence", async () => {
    const shardA = path.join(tmpRoot, "shard-official-seed-path");
    const shardB = path.join(tmpRoot, "shard-fallback-seed-path");
    const rowsA = Array.from({ length: 5 }, (_, index) => ({
      id: `q-seed-official-${index + 1}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const
    }));
    const rowsB = Array.from({ length: 5 }, (_, index) => ({
      id: `q-seed-fallback-${index + 1}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          seed_extraction_path: makeSeedExtractionPath({
            path: "official_api_compile",
            cache_hits: 1,
            llm_calls: 2,
            facts_produced: 3
          }),
          per_scenario: rowsA
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          seed_extraction_path: makeSeedExtractionPath({
            path: "no_credentials_fallback",
            llm_calls: 0,
            offline_fallbacks: 8,
            facts_produced: 9,
            signals_dropped: 2,
            parse_dropped: 1
          }),
          per_scenario: rowsB
        }
      })
    );

    const historyRoot = path.join(tmpRoot, "history-seed-extraction-path");
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

    expect(exitCode).toBe(1);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    const report = await readFile(
      path.join(historyRoot, "public", pointer.slug, "report.md"),
      "utf8"
    );
    const findings = await readFile(
      path.join(historyRoot, "public", pointer.slug, "findings.md"),
      "utf8"
    );

    expect(merged.kpi.seed_extraction_path).toEqual({
      path: "no_credentials_fallback",
      cache_hits: 1,
      llm_calls: 2,
      offline_fallbacks: 8,
      live_extraction_failures: 0,
      cached_extraction_failures: 0,
      facts_produced: 12,
      signals_dropped: 2,
      parse_dropped: 1,
      compile_overflow_dropped: 0,
      signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
    });
    expect(report).toContain("Seed extraction path: no_credentials_fallback");
    expect(report).toContain("Release evidence blockers");
    expect(findings).toContain("seed_extraction_path no_credentials_fallback");
  });

  it("blocks merged official seed extraction when any offline fallback occurs", async () => {
    const shardA = path.join(tmpRoot, "shard-official-clean-seed");
    const shardB = path.join(tmpRoot, "shard-official-offline-seed");
    const rowsA = Array.from({ length: 5 }, (_, index) => ({
      id: `q-seed-clean-${index + 1}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const
    }));
    const rowsB = Array.from({ length: 5 }, (_, index) => ({
      id: `q-seed-offline-${index + 1}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          seed_extraction_path: makeSeedExtractionPath({
            path: "official_api_compile",
            cache_hits: 10,
            facts_produced: 20
          }),
          per_scenario: rowsA
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          seed_extraction_path: makeSeedExtractionPath({
            path: "official_api_compile",
            cache_hits: 11,
            offline_fallbacks: 1,
            live_extraction_failures: 1,
            facts_produced: 21,
            signals_dropped: 4,
            parse_dropped: 3
          }),
          per_scenario: rowsB
        }
      })
    );

    const historyRoot = path.join(tmpRoot, "history-seed-offline-fallback");
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

    expect(exitCode).toBe(1);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    const report = await readFile(
      path.join(historyRoot, "public", pointer.slug, "report.md"),
      "utf8"
    );
    const findings = await readFile(
      path.join(historyRoot, "public", pointer.slug, "findings.md"),
      "utf8"
    );

    expect(merged.kpi.seed_extraction_path).toMatchObject({
      path: "official_api_compile",
      cache_hits: 21,
      offline_fallbacks: 1,
      live_extraction_failures: 1,
      cached_extraction_failures: 0,
      facts_produced: 41,
      signals_dropped: 4,
      parse_dropped: 3
    });
    expect(report).toContain("Seed extraction path: official_api_compile");
    expect(report).toContain("Release evidence blockers");
    expect(findings).toContain("seed_extraction_path live_extraction_failures");
    expect(findings).toContain("offline_fallbacks=1");
    expect(findings).toContain("live_failures=1");
  });

  it("does not add an offline-fallback blocker when merged official extraction has none", async () => {
    const shardA = path.join(tmpRoot, "shard-official-zero-a");
    const shardB = path.join(tmpRoot, "shard-official-zero-b");
    const rowsA = Array.from({ length: 5 }, (_, index) => ({
      id: `q-seed-zero-a-${index + 1}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const
    }));
    const rowsB = Array.from({ length: 5 }, (_, index) => ({
      id: `q-seed-zero-b-${index + 1}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          seed_extraction_path: makeSeedExtractionPath({
            path: "official_api_compile",
            cache_hits: 5,
            facts_produced: 10
          }),
          per_scenario: rowsA
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          seed_extraction_path: makeSeedExtractionPath({
            path: "official_api_compile",
            cache_hits: 6,
            facts_produced: 11
          }),
          per_scenario: rowsB
        }
      })
    );

    const historyRoot = path.join(tmpRoot, "history-seed-official-zero");
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

    expect(exitCode).toBe(1);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(evaluateSeedExtractionReleaseBlocker(merged)).toBeNull();
  });
});
