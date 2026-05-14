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
    "- **Scoring rule.** The bench harness scores hits by `object_id`",
    "  set-membership against a sidecar populated only by setup seeds —",
    "  not by string substring overlap. Because seeding directly controls",
    "  the sidecar contents, the bench is best read as a **self-consistency",
    "  test** (does the propose+review chain round-trip into recall at all?)",
    "  rather than as a realistic retrieval benchmark.",
    "- **Tiny `self` workspace caveat.** Each `self` scenario seeds only",
    "  1–2 setup utterances plus 3–5 distractors. The workspace is far",
    "  smaller than a real attached-agent session, so tier and cascade",
    "  behavior here will not match a production environment. Treat `self`",
    "  R@K as a regression tripwire, not as a quality measurement.",
    "- **LongMemEval Oracle degenerate filter.** On the cleaned Oracle",
    "  dataset (HuggingFace `xiaowu0162/longmemeval-cleaned`, 500/500",
    "  questions) `set(haystack_session_ids) == set(answer_session_ids)`",
    "  holds across the corpus. The runner's",
    "  `answerSessionSet.has(meta.session_id)` filter is therefore a",
    "  **no-op on Oracle**: every haystack seed is in the answer session",
    "  set. Public R@K here is really *propose+review round-trip succeeded",
    "  and recall returned **any** seed*, not *Alaya retrieved the",
    "  `has_answer=true` turn*. Do not market these numbers as honest",
    "  retrieval recall.",
    "- **v0.3.7+ fix direction.** The honest fix is a probe-only recall",
    "  path that does **not** seed the `has_answer` turn itself, plus a",
    "  real `has_answer ∩ answer_session` filter on the recall output.",
    "  Until that lands, treat the verdict below as a contract regression",
    "  alarm, not as a claim of retrieval quality."
  );
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
  lines.push(`- Latency p50: ${current.kpi.latency_ms_p50} ms`);
  lines.push(`- Latency p95: ${current.kpi.latency_ms_p95} ms`);
  lines.push(
    `- Token saved vs full-prompt baseline: ${formatRatio(current.kpi.token_saved_ratio_vs_full_prompt)}`
  );
  lines.push(
    `- Tier distribution: hot=${current.kpi.tier_distribution.hot} warm=${current.kpi.tier_distribution.warm} cold=${current.kpi.tier_distribution.cold}`
  );
  lines.push(
    `- Degradation reasons: none=${current.kpi.degradation_reasons.none} warm_cascade=${current.kpi.degradation_reasons.warm_cascade_engaged} cold_cascade=${current.kpi.degradation_reasons.cold_cascade_engaged}`
  );
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
