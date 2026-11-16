import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  diffKpis,
  listEntries,
  readEntry,
  readPrevious,
  type BenchName,
  type KpiPayload
} from "@do-soul/alaya-eval";

const ExpansionDiagnosticsSchema = z
  .object({
    scored_recall_evidence: z
      .object({
        delivered_result_count: z.number().finite().optional(),
        path_expansion_plane_count: z.number().finite().optional(),
        graph_expansion_plane_count: z.number().finite().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

interface BenchSummary {
  readonly latest_slug: string;
  readonly history_count: number;
  readonly payload: KpiPayload;
  readonly diff: {
    readonly previous_slug: string | null;
    readonly worst_verdict: "ok" | "warn" | "fail";
    readonly r_at_5_delta_pp: number | null;
  };
}

interface BenchTrendPoint {
  readonly slug: string;
  readonly bench_name: BenchName;
  readonly split: string;
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly embedding_provider: string;
  readonly policy_shape: string;
  readonly simulate_report: string;
  readonly evaluated_count: number;
  readonly sample_size: number;
  readonly r_at_1: number;
  readonly r_at_5: number;
  readonly r_at_10: number;
  readonly latency_ms_p95: number;
  readonly token_saved_ratio_vs_full_prompt: number | null;
  // Event-sourced token-economy figures. null when kpi.json has no
  // token_economy block.
  readonly raw_history_tokens: number | null;
  readonly stored_memory_tokens: number | null;
  readonly recalled_context_tokens_mean: number | null;
  readonly seed_event_count: number | null;
  readonly path_expansion_share: number | null;
  readonly graph_expansion_share: number | null;
}

interface BenchTrend {
  readonly bench_name: BenchName;
  readonly history_count: number;
  readonly points: readonly BenchTrendPoint[];
}

interface BenchHistoryOutcome<T> {
  readonly value: T | null;
  readonly error: string | null;
}

export async function projectBenchSummary(
  historyRoot: string,
  benchName: BenchName
) {
  try {
    return { value: await summarize(historyRoot, benchName), error: null } satisfies BenchHistoryOutcome<BenchSummary>;
  } catch (err) {
    const reason = classifyError(err);
    console.error(`[bench-summary] ${benchName} summary failed:`, reason, err);
    return { value: null, error: reason } satisfies BenchHistoryOutcome<BenchSummary>;
  }
}

export async function projectBenchTrend(
  historyRoot: string,
  benchName: BenchName,
  limit: number
) {
  try {
    return { value: await summarizeTrend(historyRoot, benchName, limit), error: null } satisfies BenchHistoryOutcome<BenchTrend>;
  } catch (err) {
    const reason = classifyError(err);
    console.error(`[bench-trend] ${benchName} trend failed:`, reason, err);
    return { value: null, error: reason } satisfies BenchHistoryOutcome<BenchTrend>;
  }
}

function classifyError(err: unknown): string {
  if (err instanceof SyntaxError) return "kpi_json_invalid";
  const name = err instanceof Error ? err.name : "";
  if (name === "ZodError") return "kpi_schema_invalid";
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return `io_${code.toLowerCase()}`;
  }
  return "summary_failed";
}

async function summarize(
  historyRoot: string,
  benchName: BenchName
) {
  const layout = { historyRoot };
  // Inspector latest is the last listEntries slug, not eval readLatest
  // (pointer / passing / legacy policy).
  const slugs = await listEntries(layout, benchName);
  if (slugs.length === 0) return null;
  const latestSlug = slugs[slugs.length - 1];
  if (latestSlug === undefined) return null;
  const latest = await readEntry(layout, benchName, latestSlug);
  if (latest === null) return null;
  const previous = await readPrevious(layout, benchName, latestSlug);
  const previousSlug = slugs.length >= 2 ? slugs[slugs.length - 2] ?? null : null;
  const diff = diffKpis(latest, previous);
  const r_at_5_delta_pp =
    previous === null ? null : (latest.kpi.r_at_5 - previous.kpi.r_at_5) * 100;
  return {
    latest_slug: latestSlug,
    history_count: slugs.length,
    payload: latest,
    diff: {
      previous_slug: previousSlug,
      worst_verdict: diff.worst_verdict,
      r_at_5_delta_pp
    }
  } satisfies BenchSummary;
}

async function summarizeTrend(
  historyRoot: string,
  benchName: BenchName,
  limit: number
) {
  const layout = { historyRoot };
  const slugs = await listEntries(layout, benchName);
  if (slugs.length === 0) return null;
  const selectedSlugs = slugs.slice(-limit);
  const points = (
    await Promise.all(
      selectedSlugs.map((slug) => readTrendPoint(historyRoot, layout, benchName, slug))
    )
  ).filter((point): point is NonNullable<typeof point> => point !== null);
  return {
    bench_name: benchName,
    history_count: slugs.length,
    points
  } satisfies BenchTrend;
}

async function readTrendPoint(
  historyRoot: string,
  layout: { readonly historyRoot: string },
  benchName: BenchName,
  slug: string
) {
  const payload = await readEntry(layout, benchName, slug);
  if (payload === null) return null;
  const expansion = await readExpansionShares(historyRoot, benchName, slug);
  // An unavailable economy reports unknown figures, never zeros.
  const economy = payload.kpi.token_economy?.schema_version === "bench-token-economy.v1"
    ? payload.kpi.token_economy
    : undefined;
  return {
    slug,
    bench_name: benchName,
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    embedding_provider: payload.embedding_provider,
    policy_shape: payload.policy_shape ?? "stress",
    simulate_report: payload.simulate_report ?? "none",
    evaluated_count: payload.evaluated_count,
    sample_size: payload.sample_size,
    r_at_1: payload.kpi.r_at_1,
    r_at_5: payload.kpi.r_at_5,
    r_at_10: payload.kpi.r_at_10,
    latency_ms_p95: payload.kpi.latency_ms_p95,
    token_saved_ratio_vs_full_prompt: payload.kpi.token_saved_ratio_vs_full_prompt,
    raw_history_tokens: economy?.raw_history_tokens ?? null,
    stored_memory_tokens: economy?.stored_memory_tokens ?? null,
    recalled_context_tokens_mean: economy?.recalled_context_tokens_mean ?? null,
    seed_event_count: economy?.seed_event_count ?? null,
    path_expansion_share: expansion.pathExpansionShare,
    graph_expansion_share: expansion.graphExpansionShare
  } satisfies BenchTrendPoint;
}

async function readExpansionShares(
  historyRoot: string,
  benchName: BenchName,
  slug: string
): Promise<{
  readonly pathExpansionShare: number | null;
  readonly graphExpansionShare: number | null;
}> {
  let raw: string;
  try {
    raw = await readFile(
      path.join(historyRoot, benchName, slug, "longmemeval-diagnostics.json"),
      "utf8"
    );
  } catch (error) {
    if (isEnoent(error)) {
      return { pathExpansionShare: null, graphExpansionShare: null };
    }
    throw error;
  }
  const parsed = ExpansionDiagnosticsSchema.parse(JSON.parse(raw));
  const evidence = parsed.scored_recall_evidence;
  const delivered = readNumber(evidence?.delivered_result_count);
  if (delivered === null || delivered <= 0) {
    return { pathExpansionShare: null, graphExpansionShare: null };
  }
  const pathCount = readNumber(evidence?.path_expansion_plane_count);
  const graphCount = readNumber(evidence?.graph_expansion_plane_count);
  return {
    pathExpansionShare: pathCount === null ? null : pathCount / delivered,
    graphExpansionShare: graphCount === null ? null : graphCount / delivered
  };
}

function isEnoent(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
