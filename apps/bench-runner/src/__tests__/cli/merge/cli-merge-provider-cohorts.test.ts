import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { buildMergedLongMemEvalPayload } from "../../../cli/merge/command/merge-command-shards.js";
import { validateLongMemEvalReleaseDiagnostics } from "../../../diagnostics/release-evidence-validator.js";
import { summarizeProviderStates } from "../../../diagnostics/diagnostics-question.js";
import type { LongMemEvalQuestionDiagnostic } from "../../../diagnostics/schema/diagnostics-types.js";
import { promotionMeasurementDiagnostic } from "../../longmemeval/recall-eval/specialized-answerable-recall-fixture.js";
import { runMergeCli } from "./cli-merge-dataset-fixture.js";
import { makeShardKpi, makeQualityMetrics, makeEligibleMeasurementAttribution,
  makeValidShardDiagnostics, writeShardRoot, LONGMEMEVAL_DIAGNOSTICS_FILENAME
} from "./cli-merge-validations-fixture.js";

describe("merged provider-returned scorable cohort", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "merge-provider-cohorts-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("weights unequal returned cohorts by current scorable diagnostics", () => {
    const shards = [providerShard("a", [true], 3), providerShard("b", [false], 0)];
    const merged = merge(shards);
    expect(merged.kpi.r_at_5_with_embedding_returned).toBe(0.5);
    expect(merged.kpi.provider_returned_rate).toBe(1);
    expect(merged).toMatchObject({ evaluated_count: 5, answerable_evaluated_count: 2 });
  });

  it("does not dilute the scorable subset with an entirely unscorable returned shard", () => {
    const merged = merge([providerShard("a", [true], 0), providerShard("b", [], 3)]);
    expect(merged.kpi.r_at_5_with_embedding_returned).toBe(1);
    expect(merged.kpi.provider_returned_rate).toBe(1);
    expect(merged).toMatchObject({ evaluated_count: 4, answerable_evaluated_count: 1 });
  });

  it.each(["missing ledger", "legacy ledger", "partial diagnostics"])(
    "keeps the returned subset unavailable with %s", (absence) => {
      const shards = [providerShard("a", [true], 3), providerShard("b", [false], 0)];
      const questions = shards.flatMap((shard) => shard.questions);
      const first = questions[0]!;
      const diagnostics = absence === "partial diagnostics" ? questions.slice(1) : [
        { ...first, cohort_ledger: absence === "missing ledger" ? undefined
          : { ...first.cohort_ledger!, measurement_evidence_mode: "legacy_synthesized" as const } },
        ...questions.slice(1)
      ];
      const merged = merge(shards, diagnostics);
      expect(merged.kpi.r_at_5_with_embedding_returned).toBeUndefined();
      expect(merged.kpi.provider_returned_rate).toBe(1);
    }
  );

  it("archives the merged subset and passes the full diagnostics validator", async () => {
    const shards = [providerShard("a", [true], 3), providerShard("b", [false], 0)];
    const roots = shards.map((_shard, index) => path.join(root, `shard-${index}`));
    for (const [index, shard] of shards.entries()) {
      await writeShardRoot(roots[index]!, shard.payload, makeValidShardDiagnostics({
        embedding_provider: shard.payload.embedding_provider,
        embedding_mode: "env",
        policy_shape: shard.payload.policy_shape,
        simulate_report: shard.payload.simulate_report,
        seed_extraction_path: shard.payload.kpi.seed_extraction_path,
        report_usage: undefined,
        report_side_effects: undefined,
        provider_state_summary: summarizeProviderStates(shard.questions),
        questions: shard.questions
      }));
    }
    const historyRoot = path.join(root, "history");
    expect(await runMergeCli(root, ["merge-longmemeval", "--variant", "s",
      "--history-root", historyRoot, "--shards", ...roots])).toBe(1);
    const pointer = JSON.parse(await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8"));
    const archiveRoot = path.join(historyRoot, "public", pointer.slug);
    const payload = JSON.parse(await readFile(path.join(archiveRoot, "kpi.json"), "utf8")) as KpiPayload;
    const compact = JSON.parse(await readFile(path.join(archiveRoot, LONGMEMEVAL_DIAGNOSTICS_FILENAME), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(archiveRoot, "longmemeval-evidence-manifest.json"), "utf8")) as {
      artifacts: { role: string; path: string }[]
    };
    const full = manifest.artifacts.find((artifact) => artifact.role === "full_diagnostics")!;
    expect(compact.full_diagnostics_artifact_path).toMatch(/\.json\.gz$/u);
    const contents = await readFile(path.resolve(archiveRoot, full.path));
    expect(payload.kpi.r_at_5_with_embedding_returned).toBe(0.5);
    expect(payload.kpi.provider_returned_rate).toBe(1);
    await expect(validateLongMemEvalReleaseDiagnostics({ contents, payload })).resolves.toBeUndefined();
    await expect(validateLongMemEvalReleaseDiagnostics({ contents, payload: {
      ...payload, kpi: { ...payload.kpi, r_at_5_with_embedding_returned: 0.8 }
    } })).rejects.toThrow(/provider rates/u);
  });
});

function merge(
  shards: readonly ReturnType<typeof providerShard>[],
  questionDiagnostics = shards.flatMap((shard) => shard.questions)
): KpiPayload {
  const payloads = shards.map((shard) => shard.payload);
  return buildMergedLongMemEvalPayload({ payloads, first: payloads[0]!,
    archiveRefs: [], questionDiagnostics }).payload;
}

function providerShard(prefix: string, answerableHits: readonly boolean[], abstentions: number) {
  const questions: LongMemEvalQuestionDiagnostic[] = [
    ...answerableHits.map((hit, index) => promotionMeasurementDiagnostic(`${prefix}-${index}`, "scorable", hit)),
    ...Array.from({ length: abstentions }, (_, index) =>
      promotionMeasurementDiagnostic(`${prefix}-${index}_abs`, "abstention", false))
  ];
  const evaluated = questions.length;
  const scorable = answerableHits.length;
  const hits = answerableHits.filter(Boolean).length;
  const rate = scorable === 0 ? 0 : hits / scorable;
  const base = makeShardKpi();
  const payload = makeShardKpi({ evaluated_count: evaluated, answerable_evaluated_count: scorable,
    embedding_provider: "openai:fixture", measurement_attribution: makeEligibleMeasurementAttribution(),
    kpi: { ...base.kpi, r_at_1: rate, r_at_5: rate, r_at_10: rate,
      r_at_5_overall: hits / evaluated,
      ...(scorable === 0 ? {} : { r_at_5_with_embedding_returned: rate }),
      provider_returned_rate: 1, provider_pending_rate: 0, provider_failed_rate: 0,
      provider_not_requested_rate: 0, query_embedding_unusable_rate: 0,
      quality_metrics: { ...makeQualityMetrics({ denominator: scorable, candidateAbsent: scorable - hits }),
        abstention: { schema_version: "bench-abstention.v2", total: abstentions, scored: 0,
          unscorable: abstentions, method: "fused_margin_diagnostic_only", calibration_status: "uncalibrated",
          gate_eligible: false },
        measurement_cohort_counts: { evaluated, non_abstention: scorable, abstention: abstentions,
          scorable_answerable: scorable, unscorable_answerable: 0, hit_at_5: hits, miss_at_5: scorable - hits },
        unscorable_reason_distribution: abstentions === 0 ? {} : { abstention_uncalibrated: abstentions }
      },
      per_scenario: questions.map((question) => ({ id: question.question_id, version: 1,
        hit_at_1: question.hit_at_1, hit_at_5: question.hit_at_5, hit_at_10: question.hit_at_10,
        scorable: !question.is_abstention, measurement_cohort: question.is_abstention
          ? "dataset_declared_abstention" : "answerable", tier: "warm" }))
    }
  });
  return { payload, questions };
}
