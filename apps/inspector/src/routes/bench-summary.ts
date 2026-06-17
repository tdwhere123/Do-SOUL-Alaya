import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import {
  diffKpis,
  listEntries,
  readEntry,
  readPrevious,
  type BenchName,
  type KpiPayload
} from "@do-soul/alaya-eval";

export interface BenchSummaryOptions {
  readonly historyRoot: string;
}

const TREND_BENCH_NAMES: readonly BenchName[] = [
  "self",
  "public",
  "public-multiturn",
  "public-crossquestion",
  "public-locomo",
  "live"
];

export interface BenchSummary {
  readonly latest_slug: string;
  readonly history_count: number;
  readonly payload: KpiPayload;
  readonly diff: {
    readonly previous_slug: string | null;
    readonly worst_verdict: "ok" | "warn" | "fail";
    readonly r_at_5_delta_pp: number | null;
  };
}

export interface BenchTrendPoint {
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
  readonly token_saved_ratio_vs_full_prompt: number;
  // Event-sourced token-economy figures (S6). null on pre-S6 archives
  // whose kpi.json carries no token_economy block.
  readonly raw_history_tokens: number | null;
  readonly stored_memory_tokens: number | null;
  readonly recalled_context_tokens_mean: number | null;
  readonly seed_event_count: number | null;
  readonly path_expansion_share: number | null;
  readonly graph_expansion_share: number | null;
}

export interface BenchTrend {
  readonly bench_name: BenchName;
  readonly history_count: number;
  readonly points: readonly BenchTrendPoint[];
}

export function registerInspectorBenchSummaryRoutes(
  app: Hono,
  options: BenchSummaryOptions
): void {
  app.get("/api/bench-summary", async (context) => {
    const [selfResult, publicResult, publicMultiturnResult, liveResult] =
      await Promise.all([
        summarizeSafe(options.historyRoot, "self"),
        summarizeSafe(options.historyRoot, "public"),
        summarizeSafe(options.historyRoot, "public-multiturn"),
        summarizeSafe(options.historyRoot, "live")
      ]);
    return context.json(
      {
        success: true,
        data: {
          self: selfResult.value,
          public: publicResult.value,
          public_multiturn: publicMultiturnResult.value,
          live: liveResult.value,
          errors: {
            self: selfResult.error,
            public: publicResult.error,
            public_multiturn: publicMultiturnResult.error,
            live: liveResult.error
          }
        }
      },
      200
    );
  });

  app.get("/api/bench-trend", async (context) => {
    const limit = parseLimit(context.req.query("limit"));
    const entries = await Promise.all(
      TREND_BENCH_NAMES.map(async (benchName) => [
        benchName,
        await summarizeTrendSafe(options.historyRoot, benchName, limit)
      ] as const)
    );
    const data = Object.fromEntries(
      entries.map(([benchName, result]) => [trendResponseKey(benchName), result.value])
    );
    const errors = Object.fromEntries(
      entries.map(([benchName, result]) => [trendResponseKey(benchName), result.error])
    );
    return context.json(
      {
        success: true,
        data: {
          ...data,
          errors
        }
      },
      200
    );
  });
}

interface SummarizeOutcome {
  readonly value: BenchSummary | null;
  readonly error: string | null;
}

async function summarizeSafe(
  historyRoot: string,
  benchName: BenchName
): Promise<SummarizeOutcome> {
  try {
    return { value: await summarize(historyRoot, benchName), error: null };
  } catch (err) {
    const reason = classifyError(err);
    console.error(`[bench-summary] ${benchName} summary failed:`, reason, err);
    return { value: null, error: reason };
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
): Promise<BenchSummary | null> {
  const layout = { historyRoot };
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
  };
}

async function summarizeTrendSafe(
  historyRoot: string,
  benchName: BenchName,
  limit: number
): Promise<{ readonly value: BenchTrend | null; readonly error: string | null }> {
  try {
    return { value: await summarizeTrend(historyRoot, benchName, limit), error: null };
  } catch (err) {
    const reason = classifyError(err);
    console.error(`[bench-trend] ${benchName} trend failed:`, reason, err);
    return { value: null, error: reason };
  }
}

async function summarizeTrend(
  historyRoot: string,
  benchName: BenchName,
  limit: number
): Promise<BenchTrend | null> {
  const layout = { historyRoot };
  const slugs = await listEntries(layout, benchName);
  if (slugs.length === 0) return null;
  const selectedSlugs = slugs.slice(-limit);
  const points = (
    await Promise.all(
      selectedSlugs.map(async (slug): Promise<BenchTrendPoint | null> => {
        const payload = await readEntry(layout, benchName, slug);
        if (payload === null) {
          return null;
        }
        const expansion = await readExpansionShares(historyRoot, benchName, slug);
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
          raw_history_tokens: payload.kpi.token_economy?.raw_history_tokens ?? null,
          stored_memory_tokens:
            payload.kpi.token_economy?.stored_memory_tokens ?? null,
          recalled_context_tokens_mean:
            payload.kpi.token_economy?.recalled_context_tokens_mean ?? null,
          seed_event_count: payload.kpi.token_economy?.seed_event_count ?? null,
          path_expansion_share: expansion.pathExpansionShare,
          graph_expansion_share: expansion.graphExpansionShare
        };
      })
    )
  ).filter((point): point is BenchTrendPoint => point !== null);
  return {
    bench_name: benchName,
    history_count: slugs.length,
    points
  };
}

async function readExpansionShares(
  historyRoot: string,
  benchName: BenchName,
  slug: string
): Promise<{
  readonly pathExpansionShare: number | null;
  readonly graphExpansionShare: number | null;
}> {
  try {
    const raw = await readFile(
      path.join(historyRoot, benchName, slug, "longmemeval-diagnostics.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as {
      readonly scored_recall_evidence?: {
        readonly delivered_result_count?: unknown;
        readonly path_expansion_plane_count?: unknown;
        readonly graph_expansion_plane_count?: unknown;
      };
    };
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
  } catch {
    return { pathExpansionShare: null, graphExpansionShare: null };
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trendResponseKey(benchName: BenchName): string {
  return benchName.replaceAll("-", "_");
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 30;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(Math.max(parsed, 1), 90);
}
