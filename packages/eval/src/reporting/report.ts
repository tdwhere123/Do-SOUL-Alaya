import type { KpiPayload } from "../schema/kpi-schema.js";
import { verdictBadge } from "../history/diff.js";
import type { KpiDiffResult } from "../gates/thresholds.js";
import { deriveSampleSizeLabel } from "../metrics/wilson-ci.js";
import {
  collectReleaseHardGates,
  combineVerdicts
} from "../gates/release-gates.js";
import { renderAbsoluteKpis } from "./report-absolute-kpis.js";

export function renderReport(
  current: KpiPayload,
  previous: KpiPayload | null,
  diff: KpiDiffResult
): string {
  const lines: string[] = [];

  renderReportHeader(lines, current);
  renderScoringContract(lines, current);
  renderVerdictSection(lines, current, diff);
  renderDeltaSection(lines, previous, diff);
  renderAbsoluteKpis(lines, current);
  renderPerScenarioRows(lines, current);

  return lines.join("\n");
}

function renderReportHeader(lines: string[], current: KpiPayload): void {
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
  if (current.answerable_evaluated_count !== undefined) {
    headerLines.splice(2, 0,
      `- Recall metric denominator: ${current.answerable_evaluated_count} answerable/scorable questions`
    );
  }
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

}

function renderScoringContract(lines: string[], current: KpiPayload): void {
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
      "  `var/checks/alaya-live` run into bench-history so live provider,",
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

}

function renderVerdictSection(lines: string[], current: KpiPayload, diff: KpiDiffResult): void {
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

}

function renderDeltaSection(lines: string[], previous: KpiPayload | null, diff: KpiDiffResult): void {
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

}

function renderPerScenarioRows(lines: string[], current: KpiPayload): void {
  if (current.kpi.per_scenario.length > 0) {
    lines.push("## Per-scenario rows");
    lines.push("");
    lines.push("| id | version | hit_at_5 | scorable | tier |");
    lines.push("|---|---|---|---|---|");
    for (const row of current.kpi.per_scenario) {
      const scorable = row.scorable === false ? "no" : "yes";
      const hitAt5 = row.scorable === false ? "N/A" : row.hit_at_5 ? "✓" : "✗";
      lines.push(
        `| ${row.id} | ${row.version} | ${hitAt5} | ${scorable} | ${row.tier} |`
      );
    }
    lines.push("");
  }

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
