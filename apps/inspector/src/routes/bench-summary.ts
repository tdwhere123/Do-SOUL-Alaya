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
    const [selfResult, publicResult, liveResult] = await Promise.all([
      summarizeSafe(options.historyRoot, "self"),
      summarizeSafe(options.historyRoot, "public"),
      summarizeSafe(options.historyRoot, "live")
    ]);
    return context.json(
      {
        success: true,
        data: {
          self: selfResult.value,
          public: publicResult.value,
          live: liveResult.value,
          errors: {
            self: selfResult.error,
            public: publicResult.error,
            live: liveResult.error
          }
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
