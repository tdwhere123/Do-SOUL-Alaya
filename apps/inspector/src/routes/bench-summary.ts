import type { Hono } from "hono";
import type { BenchName } from "@do-soul/alaya-eval";
import { projectBenchSummary, projectBenchTrend } from "../bench-history.js";

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

export function registerInspectorBenchSummaryRoutes(
  app: Hono,
  options: BenchSummaryOptions
): void {
  registerBenchSummaryRoute(app, options);
  registerBenchTrendRoute(app, options);
}

function registerBenchSummaryRoute(app: Hono, options: BenchSummaryOptions): void {
  app.get("/api/bench-summary", async (context) => {
    const [selfResult, publicResult, publicMultiturnResult, liveResult] =
      await Promise.all([
        projectBenchSummary(options.historyRoot, "self"),
        projectBenchSummary(options.historyRoot, "public"),
        projectBenchSummary(options.historyRoot, "public-multiturn"),
        projectBenchSummary(options.historyRoot, "live")
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
}

function registerBenchTrendRoute(app: Hono, options: BenchSummaryOptions): void {
  app.get("/api/bench-trend", async (context) => {
    const limit = parseLimit(context.req.query("limit"));
    const entries = await Promise.all(
      TREND_BENCH_NAMES.map(async (benchName) => [
        benchName,
        await projectBenchTrend(options.historyRoot, benchName, limit)
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

function trendResponseKey(benchName: BenchName): string {
  return benchName.replaceAll("-", "_");
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 30;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(Math.max(parsed, 1), 90);
}
