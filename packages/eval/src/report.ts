import type { KpiPayload } from "./kpi-schema.js";
import { verdictBadge } from "./diff.js";
import type { KpiDiffResult } from "./thresholds.js";

export function renderReport(
  current: KpiPayload,
  previous: KpiPayload | null,
  diff: KpiDiffResult
): string {
  const lines: string[] = [];
  lines.push(`# Bench Report — ${current.bench_name} / ${current.split}`);
  lines.push("");
  lines.push(
    `- Run at: ${current.run_at}`,
    `- Sample size: ${current.sample_size} (evaluated ${current.evaluated_count}/${current.sample_size})`,
    `- Harness mode: ${current.harness_mode}`,
    `- Alaya commit: ${current.alaya_commit} (${current.alaya_version})`,
    `- Embedding: ${current.embedding_provider}`,
    `- Chat: ${current.chat_provider}`,
    `- Dataset: ${current.dataset.name} (size=${current.dataset.size})`,
    ""
  );

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
      "  retrieval number; quote it directly."
    );
  }
  lines.push("");

  lines.push("## Verdict");
  lines.push("");
  lines.push(
    `Worst verdict: **${diff.worst_verdict.toUpperCase()}** ${verdictBadge(diff.worst_verdict)}`
  );
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
  lines.push(`- R@1: ${formatRatio(current.kpi.r_at_1)}`);
  lines.push(`- R@5: ${formatRatio(current.kpi.r_at_5)}`);
  lines.push(`- R@10: ${formatRatio(current.kpi.r_at_10)}`);
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
  const trunc = current.kpi.seed_truncation;
  lines.push(
    `- Seed truncation: turns=${trunc.seed_turns_truncated} answer_bearing=${trunc.answer_turns_truncated} chars_clipped=${trunc.seed_chars_clipped}`
  );
  if (trunc.answer_turns_truncated > 0) {
    lines.push(
      `  - ⚠ ${trunc.answer_turns_truncated} answer-bearing turn(s) had their content clipped at the protocol cap; recall cannot retrieve text past the cutoff.`
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
  if (failures.length === 0 && diff.fixture_regressions.length === 0) {
    return null;
  }
  const lines: string[] = [];
  lines.push(`# Bench Findings — ${current.bench_name} / ${current.split}`);
  lines.push("");
  lines.push(
    `Run ${current.alaya_commit} on ${current.run_at} flipped one or more KPIs into ✗ FAIL.`
  );
  lines.push("");
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
