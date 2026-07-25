import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { runCli } from "../../../cli/index.js";
import {
  buildGoldDiagnostic,
  buildQuestionDiagnosticFixture
} from "../../longmemeval/diagnostics/gold-diagnostic-fixture.js";
import {
  makeShardDiagnostics,
  makeShardKpi,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("merge-longmemeval full-gold KPI", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "merge-full-gold-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("rebuilds merged full_gold_coverage from shard diagnostics", async () => {
    const shardA = path.join(tmpRoot, "shard-full-gold-a");
    const shardB = path.join(tmpRoot, "shard-full-gold-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          per_scenario: [
            { id: "q-full-gold-a", version: 1, hit_at_5: true, tier: "warm" }
          ],
          quality_metrics: {
            ...makeShardKpi().kpi.quality_metrics!,
            object_kind_delivery: {
              memory_entry: 2,
              synthesis_capsule: 0,
              evidence_capsule: 0,
              total_delivered: 2
            }
          }
        }
      }),
      makeShardDiagnostics({
        questions: [
          buildQuestionDiagnosticFixture({
            questionId: "q-full-gold-a",
            gold: [
              buildGoldDiagnostic({
                object_id: "gold-a-1",
                object_kind: "memory_entry",
                final_rank: 1
              }),
              buildGoldDiagnostic({
                object_id: "gold-a-2",
                object_kind: "memory_entry",
                final_rank: 4
              })
            ]
          })
        ]
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0,
          per_scenario: [
            { id: "q-full-gold-b", version: 1, hit_at_5: false, tier: "warm" }
          ],
          quality_metrics: {
            ...makeShardKpi().kpi.quality_metrics!,
            object_kind_delivery: {
              memory_entry: 0,
              synthesis_capsule: 0,
              evidence_capsule: 2,
              total_delivered: 2
            }
          }
        }
      }),
      makeShardDiagnostics({
        questions: [
          buildQuestionDiagnosticFixture({
            questionId: "q-full-gold-b",
            gold: [
              buildGoldDiagnostic({ object_id: "gold-b-1", final_rank: 7 }),
              buildGoldDiagnostic({
                object_id: "gold-b-2",
                object_kind: "evidence_capsule",
                final_rank: null,
                pre_budget_rank: 80
              })
            ]
          })
        ]
      })
    );

    const historyRoot = path.join(tmpRoot, "history-full-gold");
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
    expect(merged.kpi.full_gold_coverage).toMatchObject({
      gold_bearing_questions: 2,
      full_gold_at_5: 0.5,
      full_gold_at_10: 0.5,
      gold_coverage_at_5: 0.5,
      gold_coverage_at_10: 0.75,
      pool_recall_at_50: 0.75,
      pool_recall_at_100: 1
    });
    expect(merged.kpi.full_gold_coverage?.memory_only).toMatchObject({
      gold_bearing_questions: 1,
      full_gold_at_5: 1,
      gold_coverage_at_5: 1
    });
    expect(merged.kpi.quality_metrics?.object_kind_delivery).toEqual({
      memory_entry: 2,
      synthesis_capsule: 0,
      evidence_capsule: 2,
      total_delivered: 4
    });
  });

  it("omits merged full_gold_coverage for legacy diagnostics without gold detail", async () => {
    const shard = path.join(tmpRoot, "shard-full-gold-mismatch");
    await writeShardRoot(
      shard,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          per_scenario: [
            { id: "q-full-gold-expected", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      makeShardDiagnostics({
        questions: [
          {
            question_id: "q-full-gold-expected",
            gold_memory_ids: ["gold-a-1"],
            delivered_memory_ids: ["gold-a-1"],
            delivered_gold_ids: ["gold-a-1"],
            hit_at_5: true,
            miss_reasons: [],
            provider_state: "provider_not_requested",
            candidates: []
          }
        ]
      })
    );

    const historyRoot = path.join(tmpRoot, "history-full-gold-mismatch");
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
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(merged.kpi.full_gold_coverage).toBeUndefined();
  });
});
