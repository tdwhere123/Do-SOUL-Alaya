import type { KpiPayload } from "./kpi-schema.js";
import { verdictBadge } from "./diff.js";
import type { KpiDiffResult } from "./thresholds.js";
import { deriveSampleSizeLabel, wilsonInterval } from "./wilson-ci.js";
import {
  collectReleaseHardGates,
  combineVerdicts
} from "./release-gates.js";

export function renderReport(
  current: KpiPayload,
  previous: KpiPayload | null,
  diff: KpiDiffResult
): string {
  const lines: string[] = [];
  const sampleLabel = deriveSampleSizeLabel(
    current.evaluated_count,
    current.kpi.latency_source
  );
  lines.push(`# Bench Report — ${current.bench_name} / ${current.split}`);
  lines.push("");
  const headerLines = [
    `- Run at: ${current.run_at}`,
    `- Sample size: ${current.sample_size} (evaluated ${current.evaluated_count}/${current.sample_size}, label=${sampleLabel})`,
    `- Harness mode: ${current.harness_mode}`,
    `- Alaya commit: ${current.alaya_commit} (${current.alaya_version})`,
    `- Recall pipeline: ${current.recall_pipeline_version ?? "unknown"}`,
    `- Embedding: ${current.embedding_provider}`,
    `- Chat: ${current.chat_provider}`,
    `- Policy shape: ${current.policy_shape ?? "stress"}`,
    `- Dataset: ${current.dataset.name} (size=${current.dataset.size})`
  ];
  if (current.seed_policy !== undefined) {
    headerLines.push(
      `- Seed policy: ${current.seed_policy.mode}` +
        (current.seed_policy.label_independent ? " (label-independent)" : " (uses labels)")
    );
  }
  if (current.recall_weight_overrides !== undefined) {
    headerLines.push(`- Recall weights: ${formatRecallWeightOverrides(current.recall_weight_overrides)}`);
  }
  lines.push(...headerLines, "");

  lines.push("## Scoring contract");
  lines.push("");
  lines.push(
    "Read this before quoting any KPI below as evidence of Alaya recall quality."
  );
  lines.push("");
  lines.push(
    "- **Scoring rule.** Hits are scored by `object_id` set-membership",
    "  against a sidecar populated when each haystack turn is seeded —",
    "  not by string substring overlap. A recall pointer is a hit iff its",
    "  `object_id` maps in the sidecar to a turn flagged `has_answer=true`",
    "  whose session_id is in the question's `answer_session_ids`."
  );
  if (current.bench_name === "self") {
    lines.push(
      "- **Tiny `self` workspace caveat.** Each `self` scenario seeds only",
      "  1–2 setup utterances plus 3–5 distractors. The workspace is far",
      "  smaller than a real attached-agent session, so tier and cascade",
      "  behavior here will not match a production environment. Treat `self`",
      "  R@K as a regression tripwire, not as a quality measurement."
    );
  }
  if (current.split === "longmemeval-oracle") {
    lines.push(
      "- **Oracle vs S: coarser retrieval, not no-retrieval.** On the",
      "  cleaned Oracle dataset (HuggingFace `xiaowu0162/longmemeval-cleaned`,",
      "  500/500 questions) `set(haystack_session_ids) == set(answer_session_ids)`",
      "  holds across the corpus, so the runner's",
      "  `answerSessionSet.has(meta.session_id)` filter is a no-op for the",
      "  *session* predicate. The `has_answer=true` predicate is still a",
      "  real filter — Oracle R@K measures whether top-K recall surfaces",
      "  the actual answer-bearing turn within a small (~5-15 turn)",
      "  haystack of answer-session turns. It is retrieval, but coarser:",
      "  it cannot distinguish *wrong-session* misses from *wrong-turn*",
      "  misses (because there are no distractor sessions to be the",
      "  wrong session). The `longmemeval-s` split (with ~98% distractor",
      "  session ratio per question) is the finer retrieval benchmark."
    );
  }
  if (current.split === "longmemeval-s") {
    lines.push(
      "- **LongMemEval-S retrieval evaluation.** S includes distractor",
      "  sessions whose session_id is NOT in `answer_session_ids`, so the",
      "  filter is a real predicate (not a no-op). R@K on this split means",
      "  *given the question, how often does the top-K recall surface a",
      "  `has_answer=true` turn from an answer session, when distractor",
      "  sessions are present in the haystack*. This is the honest",
      "  retrieval number; quote it directly.",
      "- **Production-extraction ingestion basis (v0.3.10).** Each turn is",
      "  run through the production garden extraction",
      "  (`OfficialApiGardenProvider.compile`) into N typed candidate",
      "  signals; an answer turn seeds N gold `object_id`s and a hit means",
      "  recalling ANY one of them. R@K is therefore measured on a new",
      "  basis and is NOT directly comparable to the pre-extraction",
      "  `2026-05-20T110623Z` baseline; the first post-extraction full run",
      "  is the reference baseline for later recall-optimization slices."
    );
  }
  if (current.bench_name === "live" || current.split === "strict-real") {
    lines.push(
      "- **Live strict-real archive.** This entry normalizes an existing",
      "  `.do-it/checks/alaya-live` run into bench-history so live provider,",
      "  MCP security, semantic supplement, and Garden review-loop evidence",
      "  can be diffed beside `self` and `public`. It imports top1/top5",
      "  summary metrics and strict gate outcomes; it does not carry raw",
      "  per-query rows, raw provider transcripts, or live secrets."
    );
  }
  if (current.bench_name === "public-multiturn") {
    lines.push(
      "- **Public multi-turn archive.** This entry runs LongMemEval material",
      "  through repeated `soul.recall` → `soul.report_context_usage` rounds",
      "  in one workspace per question. Its trend line is separate from the",
      "  single-turn `public` archive because usage-derived graph/path signals",
      "  are part of the measurement."
    );
  }
  lines.push("");

  lines.push("## Verdict");
  lines.push("");
  const releaseGates = collectReleaseHardGates(current);
  const releaseGateVerdict = releaseGates.some((gate) => !gate.passed)
    ? "fail"
    : "ok";
  const worstVerdict = combineVerdicts(diff.worst_verdict, releaseGateVerdict);
  lines.push(
    `Worst verdict: **${worstVerdict.toUpperCase()}** ${verdictBadge(worstVerdict)}`
  );
  if (releaseGates.length > 0) {
    lines.push("");
    lines.push("Release hard gates:");
    for (const gate of releaseGates) {
      const comparator = gate.direction === "min"
        ? gate.passed ? ">=" : "<"
        : gate.passed ? "<=" : ">";
      lines.push(
        `- ${gate.passed ? "✓" : "✗"} ${formatHardGateName(gate)}: ${formatGateValue(gate.current, gate.unit)} ${comparator} target ${formatGateValue(gate.target, gate.unit)}`
      );
    }
    if (releaseGates.some((gate) => !gate.passed)) {
      lines.push(
        "  - The delta verdict is only a regression check against the previous archive entry; failed release hard gates block the archive even when no previous baseline exists."
      );
    }
  }
  lines.push("");

  if (previous === null) {
    lines.push("_No previous baseline; this is the first entry._");
    lines.push("");
  } else {
    lines.push("## Δ vs previous");
    lines.push("");
    lines.push("| KPI | previous | current | delta | verdict |");
    lines.push("|---|---|---|---|---|");
    for (const delta of diff.deltas) {
      lines.push(
        `| ${delta.key} | ${formatNumber(delta.previous)} | ${formatNumber(delta.current)} | ${formatDelta(delta.delta)} | ${verdictBadge(delta.verdict)} ${delta.verdict.toUpperCase()} |`
      );
    }
    lines.push("");
    if (diff.fixture_regressions.length > 0) {
      lines.push(
        `### Golden fixture regressions (${diff.fixture_regressions.length})`
      );
      lines.push("");
      for (const id of diff.fixture_regressions) {
        lines.push(`- ${id} flipped hit→miss`);
      }
      lines.push("");
    }
    if (diff.rebaselined_scenarios.length > 0) {
      lines.push(
        `### Rebaselined scenarios (${diff.rebaselined_scenarios.length})`
      );
      lines.push("");
      lines.push(
        "_Version bumped vs previous run; per-row hit deltas suppressed by design._"
      );
      lines.push("");
      for (const id of diff.rebaselined_scenarios) {
        lines.push(`- ${id}`);
      }
      lines.push("");
    }
    if (diff.new_scenarios.length > 0) {
      lines.push(`### New scenarios (${diff.new_scenarios.length})`);
      lines.push("");
      lines.push("_Scenario ids not present in the previous baseline._");
      lines.push("");
      for (const id of diff.new_scenarios) {
        lines.push(`- ${id}`);
      }
      lines.push("");
    }
  }

  lines.push("## Absolute KPIs");
  lines.push("");
  lines.push(`- R@1: ${formatRatio(current.kpi.r_at_1)}${ciAnnotation(current.kpi.r_at_1, current.evaluated_count)}`);
  lines.push(`- R@5: ${formatRatio(current.kpi.r_at_5)}${ciAnnotation(current.kpi.r_at_5, current.evaluated_count)}`);
  lines.push(`- R@10: ${formatRatio(current.kpi.r_at_10)}${ciAnnotation(current.kpi.r_at_10, current.evaluated_count)}`);
  if (
    current.kpi.r_at_5_overall !== undefined ||
    current.kpi.r_at_5_with_embedding_returned !== undefined
  ) {
    lines.push(
      `- Env embedding R@5 overall: ${formatMaybeRatio(current.kpi.r_at_5_overall)}`
    );
    lines.push(
      `- Env embedding R@5 when provider returned: ${formatMaybeRatio(current.kpi.r_at_5_with_embedding_returned)}`
    );
  }
  if (
    current.kpi.r_at_5_round_1 !== undefined ||
    current.kpi.r_at_5_round_2 !== undefined ||
    current.kpi.r_at_5_round_n !== undefined
  ) {
    lines.push(
      `- Multi-turn R@5: round1=${formatMaybeRatio(current.kpi.r_at_5_round_1)} round2=${formatMaybeRatio(current.kpi.r_at_5_round_2)} round${current.kpi.multiturn_rounds ?? "N"}=${formatMaybeRatio(current.kpi.r_at_5_round_n)}`
    );
  }
  const latencyTag =
    current.kpi.latency_source === "worst_shard_bound"
      ? " (≤ worst-shard upper bound)"
      : "";
  lines.push(`- Latency p50: ${current.kpi.latency_ms_p50} ms${latencyTag}`);
  lines.push(`- Latency p95: ${current.kpi.latency_ms_p95} ms${latencyTag}`);
  lines.push(
    `- Token saved vs full-prompt baseline: ${formatRatio(current.kpi.token_saved_ratio_vs_full_prompt)}`
  );
  lines.push(
    `- Tier distribution: hot=${current.kpi.tier_distribution.hot} warm=${current.kpi.tier_distribution.warm} cold=${current.kpi.tier_distribution.cold}`
  );
  lines.push(
    `- Degradation reasons: none=${current.kpi.degradation_reasons.none} warm_cascade=${current.kpi.degradation_reasons.warm_cascade_engaged} cold_cascade=${current.kpi.degradation_reasons.cold_cascade_engaged} explainability_partial=${current.kpi.degradation_reasons.recall_explainability_partial}`
  );
  if (
    current.kpi.provider_returned_rate !== undefined ||
    current.kpi.provider_pending_rate !== undefined ||
    current.kpi.provider_failed_rate !== undefined ||
    current.kpi.provider_not_requested_rate !== undefined
  ) {
    lines.push(
      `- Embedding provider states: returned=${formatMaybeRatio(current.kpi.provider_returned_rate)} pending=${formatMaybeRatio(current.kpi.provider_pending_rate)} failed=${formatMaybeRatio(current.kpi.provider_failed_rate)} not_requested=${formatMaybeRatio(current.kpi.provider_not_requested_rate)}`
    );
  }
  if (current.kpi.embedding_vector_cache_ready_rate !== undefined) {
    lines.push(
      `- Embedding vector cache ready: ${formatMaybeRatio(current.kpi.embedding_vector_cache_ready_rate)}`
    );
  }
  if (current.kpi.query_embedding_cache_ready_rate !== undefined) {
    lines.push(
      `- Query embedding cache ready: ${formatMaybeRatio(current.kpi.query_embedding_cache_ready_rate)}`
    );
  }
  const trunc = current.kpi.seed_truncation;
  lines.push(
    `- Seed truncation: turns=${trunc.seed_turns_truncated} answer_bearing=${trunc.answer_turns_truncated} chars_clipped=${trunc.seed_chars_clipped}`
  );
  if (trunc.answer_turns_truncated > 0) {
    lines.push(
      `  - ⚠ ${trunc.answer_turns_truncated} answer-bearing turn(s) had their content clipped at the protocol cap; recall cannot retrieve text past the cutoff.`
    );
  }
  const extractionPath = current.kpi.seed_extraction_path;
  if (extractionPath !== undefined) {
    lines.push(
      `- Seed extraction path: ${extractionPath.path} ` +
        `(cache_hits=${extractionPath.cache_hits} llm_calls=${extractionPath.llm_calls} ` +
        `offline_fallbacks=${extractionPath.offline_fallbacks} ` +
        `facts=${extractionPath.facts_produced} signals_dropped=${extractionPath.signals_dropped} ` +
        `[parse_dropped=${extractionPath.parse_dropped} ` +
        `compile_overflow_dropped=${extractionPath.compile_overflow_dropped}])`
    );
    if (extractionPath.path === "no_credentials_fallback") {
      lines.push(
        "  - ⚠ This run took the no-credentials fallback: each turn was",
        "    seeded as one full-turn fact, NOT the production multi-signal",
        "    garden extraction. The keyword-rich full turn can out-score a",
        "    tight production `distilled_fact`, so this R@K is NOT comparable",
        "    to an `official_api_compile` run."
      );
    }
    if (extractionPath.signals_dropped > 0) {
      // signals_dropped also absorbs whole-turn batches lost when seed
      // materialization throws, which parse_dropped / compile_overflow_dropped
      // do not attribute — surface that residual so the breakdown still sums.
      const seedMaterializationDropped = Math.max(
        0,
        extractionPath.signals_dropped -
          extractionPath.parse_dropped -
          extractionPath.compile_overflow_dropped
      );
      lines.push(
        `  - ⚠ ${extractionPath.signals_dropped} extracted signal(s) were lost before seeding ` +
          `(${extractionPath.parse_dropped} dropped by the parser as malformed / over the 64-signal cap, ` +
          `${extractionPath.compile_overflow_dropped} dropped by compile() as oversized, ` +
          `${seedMaterializationDropped} dropped when a seed-materialization batch failed); ` +
          `a dropped answer-bearing signal inflates the miss rate.`
      );
    }
  }
  if (current.kpi.quality_metrics !== undefined) {
    const metrics = current.kpi.quality_metrics;
    lines.push(
      `- Quality metrics: non_monotonic=${formatRatio(metrics.non_monotonic_rate)} (${metrics.non_monotonic_count}/${metrics.non_monotonic_denominator}) budget_drop_loss=${metrics.miss_distribution.budget_dropped ?? 0} budget_dropped_entries=${metrics.budget_drop_distribution.max_entries?.count ?? 0} candidate_absent=${metrics.candidate_absent_count} no_gold=${metrics.no_gold_count} evidence_gold=${formatRatio(metrics.evidence_stream_gold_delivery_rate)} path_top10=${formatRatio(metrics.path_stream_top10_rate)}`
    );
  }
  lines.push("");

  if (current.kpi.per_scenario.length > 0) {
    lines.push("## Per-scenario rows");
    lines.push("");
    lines.push("| id | version | hit_at_5 | tier |");
    lines.push("|---|---|---|---|");
    for (const row of current.kpi.per_scenario) {
      lines.push(
        `| ${row.id} | ${row.version} | ${row.hit_at_5 ? "✓" : "✗"} | ${row.tier} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderFindings(
  current: KpiPayload,
  diff: KpiDiffResult
): string | null {
  const failures = diff.deltas.filter((d) => d.verdict === "fail");
  const targetFailures = collectReleaseHardGates(current).filter(
    (gate) => !gate.passed
  );
  if (
    failures.length === 0 &&
    diff.fixture_regressions.length === 0 &&
    targetFailures.length === 0
  ) {
    return null;
  }
  const lines: string[] = [];
  lines.push(`# Bench Findings — ${current.bench_name} / ${current.split}`);
  lines.push("");
  if (failures.length > 0 || diff.fixture_regressions.length > 0) {
    lines.push(
      `Run ${current.alaya_commit} on ${current.run_at} flipped one or more KPIs into ✗ FAIL.`
    );
  } else {
    lines.push(
      `Run ${current.alaya_commit} on ${current.run_at} is below one or more absolute benchmark targets.`
    );
  }
  lines.push("");
  if (targetFailures.length > 0) {
    lines.push("## Release hard gate gaps");
    lines.push("");
    for (const failure of targetFailures) {
      const comparator = failure.direction === "min" ? "<" : ">";
      lines.push(
        `- **${formatHardGateName(failure)}**: current ${formatGateValue(failure.current, failure.unit)} ${comparator} target ${formatGateValue(failure.target, failure.unit)}`
      );
    }
    lines.push("");
  }
  if (failures.length > 0) {
    lines.push("## KPI regressions");
    lines.push("");
    for (const failure of failures) {
      lines.push(
        `- **${failure.key}**: previous ${formatNumber(failure.previous)} → current ${formatNumber(failure.current)} (Δ ${formatDelta(failure.delta)})`
      );
    }
    lines.push("");
  }
  if (diff.fixture_regressions.length > 0) {
    lines.push("## Golden fixture flips");
    lines.push("");
    for (const id of diff.fixture_regressions) {
      lines.push(`- ${id}`);
    }
    lines.push("");
  }
  lines.push("## Next step");
  lines.push("");
  lines.push(
    "Open a backlog entry in `docs/handbook/backlog.md` for each failure, with suspected root cause and proposed fix scope."
  );
  lines.push("");
  return lines.join("\n");
}

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function formatGateValue(
  value: number | null,
  unit: ReturnType<typeof collectReleaseHardGates>[number]["unit"]
): string {
  if (value === null || !Number.isFinite(value)) return "missing";
  if (unit === "ratio") return formatRatio(value);
  if (unit === "ms") return `${value}ms`;
  return String(value);
}

function formatHardGateName(gate: ReturnType<typeof collectReleaseHardGates>[number]): string {
  return `${gate.id} ${gate.label}`;
}

function formatMaybeRatio(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return formatRatio(value);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(4);
}

function formatDelta(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(4)}`;
}

function ciAnnotation(ratio: number, evaluatedCount: number): string {
  if (!Number.isFinite(ratio) || evaluatedCount <= 0) {
    return "";
  }
  const successes = Math.round(ratio * evaluatedCount);
  const interval = wilsonInterval(successes, evaluatedCount);
  const halfWidthPp = ((interval.hi - interval.lo) / 2) * 100;
  return ` (95% CI ±${halfWidthPp.toFixed(2)}pp, [${(interval.lo * 100).toFixed(2)}%, ${(interval.hi * 100).toFixed(2)}%])`;
}

function formatRecallWeightOverrides(
  summary: NonNullable<KpiPayload["recall_weight_overrides"]>
): string {
  const parts = [`source=${summary.source}`];
  if (summary.activation_weights_phase4b !== undefined) {
    parts.push(
      `activation={${formatNumberMap(summary.activation_weights_phase4b)}}`
    );
  }
  if (summary.additive !== undefined) {
    parts.push(`additive={${formatNumberMap(summary.additive)}}`);
  }
  if (summary.fusion_weights !== undefined) {
    parts.push(`fusion={${formatNumberMap(summary.fusion_weights)}}`);
  }
  return parts.join(" ");
}

function formatNumberMap(values: Readonly<Record<string, number | undefined>>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatCompactNumber(value)}`)
    .join(",");
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(6)).toString();
}
