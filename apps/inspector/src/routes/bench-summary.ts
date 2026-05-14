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

export function registerInspectorBenchSummaryRoutes(
  app: Hono,
  options: BenchSummaryOptions
): void {
  app.get("/api/bench-summary", async (context) => {
    const [selfSummary, publicSummary] = await Promise.all([
      summarizeSafe(options.historyRoot, "self"),
      summarizeSafe(options.historyRoot, "public")
    ]);
    return context.json(
      {
        success: true,
        data: { self: selfSummary, public: publicSummary }
      },
      200
    );
  });
}

async function summarizeSafe(
  historyRoot: string,
  benchName: BenchName
): Promise<BenchSummary | null> {
  try {
    return await summarize(historyRoot, benchName);
  } catch {
    return null;
  }
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
