import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import {
  INSPECTOR_SESSION_COOKIE,
  INSPECTOR_VITEST_SESSION_ID
} from "../../launch/launch-session-store.js";
import { createInspectorApp } from "../../runtime/app.js";
import {
  projectBenchSummary,
  projectBenchTrend
} from "../../bench-history.js";

const OLDER_SLUG = "2026-05-14T100000Z-aaaaaaa";
const NEWER_SLUG = "2026-05-15T100000Z-bbbbbbb";
const NEWEST_SLUG = "2026-05-16T100000Z-ccccccc";

describe("inspector bench history projection", () => {
  let historyRoot: string;

  beforeEach(async () => {
    historyRoot = await mkdtemp(path.join(tmpdir(), "inspector-bench-history-"));
  });

  afterEach(async () => {
    await rm(historyRoot, { recursive: true, force: true });
  });

  it("returns empty summary and trend when no archives exist", async () => {
    await expect(projectBenchSummary(historyRoot, "self")).resolves.toEqual({
      value: null,
      error: null
    });
    await expect(projectBenchTrend(historyRoot, "public", 30)).resolves.toEqual({
      value: null,
      error: null
    });
  });

  it("summarizes the last listEntries slug rather than a latest-run pointer", async () => {
    await writeKpi(historyRoot, "self", OLDER_SLUG, kpiPayload({
      bench_name: "self",
      alaya_commit: "aaaaaaa",
      run_at: "2026-05-14T10:00:00.000Z",
      r_at_5: 0.9
    }));
    await writeKpi(historyRoot, "self", NEWER_SLUG, kpiPayload({
      bench_name: "self",
      alaya_commit: "bbbbbbb",
      run_at: "2026-05-15T10:00:00.000Z",
      r_at_5: 0.9
    }));
    await writeFile(
      path.join(historyRoot, "self", "latest-run.json"),
      JSON.stringify({ slug: OLDER_SLUG, kpi_path: `${OLDER_SLUG}/kpi.json` }, null, 2),
      "utf8"
    );

    const outcome = await projectBenchSummary(historyRoot, "self");
    expect(outcome.error).toBeNull();
    expect(outcome.value?.latest_slug).toBe(NEWER_SLUG);
    expect(outcome.value?.history_count).toBe(2);
    expect(outcome.value?.payload.alaya_commit).toBe("bbbbbbb");
    expect(outcome.value?.diff).toEqual({
      previous_slug: OLDER_SLUG,
      worst_verdict: "ok",
      r_at_5_delta_pp: 0
    });
  });

  it("returns null summary without an error when the latest slug has no kpi.json", async () => {
    await mkdir(path.join(historyRoot, "self", NEWER_SLUG), { recursive: true });
    await expect(projectBenchSummary(historyRoot, "self")).resolves.toEqual({
      value: null,
      error: null
    });
  });

  it("classifies invalid kpi JSON as kpi_json_invalid", async () => {
    await writeKpi(historyRoot, "public", NEWER_SLUG, "{not valid json");
    await expect(projectBenchSummary(historyRoot, "public")).resolves.toEqual({
      value: null,
      error: "kpi_json_invalid"
    });
  });

  it("classifies a parseable but schema-invalid kpi as kpi_schema_invalid", async () => {
    await writeKpi(historyRoot, "public", NEWER_SLUG, { bench_name: "public" });
    await expect(projectBenchSummary(historyRoot, "public")).resolves.toEqual({
      value: null,
      error: "kpi_schema_invalid"
    });
  });

  it("keeps a valid sibling bench when another split is invalid", async () => {
    await writeKpi(historyRoot, "self", NEWER_SLUG, "{not valid json");
    await writeKpi(historyRoot, "public", NEWER_SLUG, kpiPayload({
      bench_name: "public",
      alaya_commit: "bbbbbbb",
      split: "longmemeval-s"
    }));

    const selfResult = await projectBenchSummary(historyRoot, "self");
    const publicResult = await projectBenchSummary(historyRoot, "public");
    expect(selfResult).toEqual({ value: null, error: "kpi_json_invalid" });
    expect(publicResult.error).toBeNull();
    expect(publicResult.value?.latest_slug).toBe(NEWER_SLUG);
  });

  it("returns null delta when there is no previous payload", async () => {
    await writeKpi(historyRoot, "self", NEWER_SLUG, kpiPayload({
      bench_name: "self",
      alaya_commit: "bbbbbbb",
      r_at_5: 0.5
    }));
    const outcome = await projectBenchSummary(historyRoot, "self");
    expect(outcome.value?.diff.previous_slug).toBeNull();
    expect(outcome.value?.diff.r_at_5_delta_pp).toBeNull();
  });

  it("projects a valid trend in listEntries order and honors the last-n limit", async () => {
    await writeKpi(historyRoot, "public", OLDER_SLUG, kpiPayload({
      bench_name: "public",
      alaya_commit: "aaaaaaa",
      split: "longmemeval-s",
      run_at: "2026-05-14T10:00:00.000Z"
    }));
    await writeKpi(historyRoot, "public", NEWER_SLUG, kpiPayload({
      bench_name: "public",
      alaya_commit: "bbbbbbb",
      split: "longmemeval-s",
      run_at: "2026-05-15T10:00:00.000Z"
    }));
    await writeKpi(historyRoot, "public", NEWEST_SLUG, kpiPayload({
      bench_name: "public",
      alaya_commit: "ccccccc",
      split: "longmemeval-s",
      run_at: "2026-05-16T10:00:00.000Z"
    }));

    const limited = await projectBenchTrend(historyRoot, "public", 1);
    expect(limited.error).toBeNull();
    expect(limited.value?.history_count).toBe(3);
    expect(limited.value?.points.map((point) => point.slug)).toEqual([NEWEST_SLUG]);
  });

  it("treats missing diagnostics as unknown expansion shares", async () => {
    await writeKpi(historyRoot, "public", NEWER_SLUG, kpiPayload({
      bench_name: "public",
      split: "longmemeval-s"
    }));
    const outcome = await projectBenchTrend(historyRoot, "public", 30);
    expect(outcome.error).toBeNull();
    expect(outcome.value?.points).toHaveLength(1);
    expect(outcome.value?.points[0]?.path_expansion_share).toBeNull();
    expect(outcome.value?.points[0]?.graph_expansion_share).toBeNull();
  });

  it("classifies invalid diagnostics JSON as kpi_json_invalid without dropping a sibling bench", async () => {
    await writeKpi(historyRoot, "self", NEWER_SLUG, kpiPayload({ bench_name: "self" }));
    await writeKpi(historyRoot, "public", NEWER_SLUG, kpiPayload({
      bench_name: "public",
      split: "longmemeval-s"
    }));
    await writeDiagnostics(historyRoot, "public", NEWER_SLUG, "{not valid json");

    const selfResult = await projectBenchTrend(historyRoot, "self", 30);
    const publicResult = await projectBenchTrend(historyRoot, "public", 30);
    expect(selfResult.error).toBeNull();
    expect(selfResult.value?.points).toHaveLength(1);
    expect(publicResult).toEqual({ value: null, error: "kpi_json_invalid" });
  });

  it("classifies schema-invalid diagnostics as kpi_schema_invalid", async () => {
    await writeKpi(historyRoot, "public", NEWER_SLUG, kpiPayload({
      bench_name: "public",
      split: "longmemeval-s"
    }));
    await writeDiagnostics(historyRoot, "public", NEWER_SLUG, {
      scored_recall_evidence: { delivered_result_count: "10" }
    });
    await expect(projectBenchTrend(historyRoot, "public", 30)).resolves.toEqual({
      value: null,
      error: "kpi_schema_invalid"
    });
  });

  it("keeps explicit zero expansion shares and nulls delivered-zero or unavailable figures", async () => {
    await writeKpi(historyRoot, "public", OLDER_SLUG, kpiPayload({
      bench_name: "public",
      alaya_commit: "aaaaaaa",
      split: "longmemeval-s",
      run_at: "2026-05-14T10:00:00.000Z",
      token_saved_ratio_vs_full_prompt: 0,
      token_economy: {
        schema_version: "bench-token-economy.v1",
        raw_history_tokens: 0,
        stored_memory_tokens: 0,
        recalled_context_tokens_total: 0,
        recall_event_count: 0,
        recalled_context_tokens_mean: 0,
        seed_event_count: 0
      }
    }));
    await writeDiagnostics(historyRoot, "public", OLDER_SLUG, {
      scored_recall_evidence: {
        delivered_result_count: 10,
        path_expansion_plane_count: 0,
        graph_expansion_plane_count: 0
      }
    });
    await writeKpi(historyRoot, "public", NEWER_SLUG, kpiPayload({
      bench_name: "public",
      alaya_commit: "bbbbbbb",
      split: "longmemeval-s",
      run_at: "2026-05-15T10:00:00.000Z",
      token_saved_ratio_vs_full_prompt: null,
      token_economy: {
        schema_version: "bench-token-economy-unavailable.v1",
        reason: "statement_seed_no_token_projection",
        unprojected_seed_event_count: 4
      }
    }));
    await writeDiagnostics(historyRoot, "public", NEWER_SLUG, {
      scored_recall_evidence: {
        delivered_result_count: 0,
        path_expansion_plane_count: 5,
        graph_expansion_plane_count: 5
      }
    });

    const outcome = await projectBenchTrend(historyRoot, "public", 30);
    expect(outcome.error).toBeNull();
    expect(outcome.value?.points).toHaveLength(2);
    expect(outcome.value?.points[0]).toMatchObject({
      slug: OLDER_SLUG,
      token_saved_ratio_vs_full_prompt: 0,
      raw_history_tokens: 0,
      stored_memory_tokens: 0,
      recalled_context_tokens_mean: 0,
      seed_event_count: 0,
      path_expansion_share: 0,
      graph_expansion_share: 0
    });
    expect(outcome.value?.points[1]).toMatchObject({
      slug: NEWER_SLUG,
      token_saved_ratio_vs_full_prompt: null,
      raw_history_tokens: null,
      stored_memory_tokens: null,
      recalled_context_tokens_mean: null,
      seed_event_count: null,
      path_expansion_share: null,
      graph_expansion_share: null
    });
  });
});

describe("inspector bench history loopback HTTP", () => {
  let historyRoot: string;
  let staticRoot: string;

  beforeEach(async () => {
    historyRoot = await mkdtemp(path.join(tmpdir(), "inspector-bench-http-"));
    staticRoot = await mkdtemp(path.join(tmpdir(), "inspector-static-"));
  });

  afterEach(async () => {
    await rm(historyRoot, { recursive: true, force: true });
    await rm(staticRoot, { recursive: true, force: true });
  });

  it("returns empty summary and trend envelopes over loopback HTTP", async () => {
    const { server, origin } = await listenLoopback(historyRoot, staticRoot);
    try {
      const summary = await fetchJson(`${origin}/api/bench-summary`);
      expect(summary.status).toBe(200);
      expect(summary.body).toEqual({
        success: true,
        data: {
          self: null,
          public: null,
          public_multiturn: null,
          live: null,
          errors: { self: null, public: null, public_multiturn: null, live: null }
        }
      });

      const trend = await fetchJson(`${origin}/api/bench-trend`);
      expect(trend.status).toBe(200);
      expect(trend.body).toEqual({
        success: true,
        data: {
          self: null,
          public: null,
          public_multiturn: null,
          public_crossquestion: null,
          public_locomo: null,
          live: null,
          errors: {
            self: null,
            public: null,
            public_multiturn: null,
            public_crossquestion: null,
            public_locomo: null,
            live: null
          }
        }
      });
    } finally {
      await closeServer(server);
    }
  });

  it("preserves invalid-json isolation, pointer-independent latest, and stable-zero shares over loopback HTTP", async () => {
    await writeKpi(historyRoot, "self", OLDER_SLUG, kpiPayload({
      bench_name: "self",
      alaya_commit: "aaaaaaa",
      run_at: "2026-05-14T10:00:00.000Z",
      r_at_5: 0.4
    }));
    await writeKpi(historyRoot, "self", NEWER_SLUG, kpiPayload({
      bench_name: "self",
      alaya_commit: "bbbbbbb",
      run_at: "2026-05-15T10:00:00.000Z",
      r_at_5: 0.4
    }));
    await writeFile(
      path.join(historyRoot, "self", "latest-run.json"),
      JSON.stringify({ slug: OLDER_SLUG, kpi_path: `${OLDER_SLUG}/kpi.json` }, null, 2),
      "utf8"
    );
    await writeKpi(historyRoot, "public", NEWER_SLUG, "{not valid json");
    await writeKpi(historyRoot, "public-multiturn", NEWER_SLUG, kpiPayload({
      bench_name: "public-multiturn",
      split: "longmemeval-s",
      alaya_commit: "bbbbbbb",
      token_saved_ratio_vs_full_prompt: null,
      token_economy: {
        schema_version: "bench-token-economy-unavailable.v1",
        reason: "statement_seed_no_token_projection",
        unprojected_seed_event_count: 2
      }
    }));
    await writeDiagnostics(historyRoot, "public-multiturn", NEWER_SLUG, {
      scored_recall_evidence: {
        delivered_result_count: 10,
        path_expansion_plane_count: 0,
        graph_expansion_plane_count: 2
      }
    });

    const { server, origin } = await listenLoopback(historyRoot, staticRoot);
    try {
      const summary = await fetchJson(`${origin}/api/bench-summary`);
      expect(summary.status).toBe(200);
      const summaryData = summary.body as {
        readonly success: true;
        readonly data: {
          readonly self: {
            readonly latest_slug: string;
            readonly payload: { readonly alaya_commit: string };
            readonly diff: {
              readonly previous_slug: string | null;
              readonly r_at_5_delta_pp: number | null;
            };
          } | null;
          readonly public: unknown;
          readonly public_multiturn: { readonly latest_slug: string } | null;
          readonly errors: {
            readonly self: string | null;
            readonly public: string | null;
            readonly public_multiturn: string | null;
          };
        };
      };
      expect(summaryData.data.errors.self).toBeNull();
      expect(summaryData.data.errors.public).toBe("kpi_json_invalid");
      expect(summaryData.data.errors.public_multiturn).toBeNull();
      expect(summaryData.data.public).toBeNull();
      expect(summaryData.data.self?.latest_slug).toBe(NEWER_SLUG);
      expect(summaryData.data.self?.payload.alaya_commit).toBe("bbbbbbb");
      expect(summaryData.data.self?.diff.previous_slug).toBe(OLDER_SLUG);
      expect(summaryData.data.self?.diff.r_at_5_delta_pp).toBe(0);
      expect(summaryData.data.public_multiturn?.latest_slug).toBe(NEWER_SLUG);

      const trend = await fetchJson(`${origin}/api/bench-trend?limit=1`);
      expect(trend.status).toBe(200);
      const trendData = trend.body as {
        readonly data: {
          readonly self: { readonly history_count: number; readonly points: readonly { readonly slug: string }[] };
          readonly public: unknown;
          readonly public_multiturn: {
            readonly points: readonly {
              readonly path_expansion_share: number | null;
              readonly graph_expansion_share: number | null;
              readonly raw_history_tokens: number | null;
              readonly seed_event_count: number | null;
            }[];
          };
          readonly errors: { readonly public: string | null; readonly public_multiturn: string | null };
        };
      };
      expect(trendData.data.errors.public).toBe("kpi_json_invalid");
      expect(trendData.data.public).toBeNull();
      expect(trendData.data.self.history_count).toBe(2);
      expect(trendData.data.self.points.map((point) => point.slug)).toEqual([NEWER_SLUG]);
      expect(trendData.data.errors.public_multiturn).toBeNull();
      expect(trendData.data.public_multiturn.points[0]).toMatchObject({
        path_expansion_share: 0,
        graph_expansion_share: 0.2,
        raw_history_tokens: null,
        seed_event_count: null
      });
    } finally {
      await closeServer(server);
    }
  });
});

function kpiPayload(overrides: {
  readonly bench_name?: "self" | "public" | "public-multiturn";
  readonly split?: "synthetic" | "longmemeval-s";
  readonly alaya_commit?: string;
  readonly run_at?: string;
  readonly r_at_5?: number;
  readonly token_saved_ratio_vs_full_prompt?: number | null;
  readonly token_economy?: unknown;
}): Record<string, unknown> {
  const benchName = overrides.bench_name ?? "self";
  return {
    bench_name: benchName,
    split: overrides.split ?? (benchName === "self" ? "synthetic" : "longmemeval-s"),
    run_at: overrides.run_at ?? "2026-05-15T10:00:00.000Z",
    alaya_commit: overrides.alaya_commit ?? "bbbbbbb",
    alaya_version: "0.3.11",
    embedding_provider: "none",
    chat_provider: "none",
    dataset: { name: "synthetic", size: 12, source: "internal" },
    sample_size: 12,
    evaluated_count: 12,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.2,
      r_at_5: overrides.r_at_5 ?? 0.6,
      r_at_10: 0.7,
      latency_ms_p50: 80,
      latency_ms_p95: 150,
      token_saved_ratio_vs_full_prompt: overrides.token_saved_ratio_vs_full_prompt === undefined
        ? 0.8
        : overrides.token_saved_ratio_vs_full_prompt,
      tier_distribution: { hot: 3, warm: 5, cold: 2 },
      degradation_reasons: {
        none: 8,
        warm_cascade_engaged: 1,
        cold_cascade_engaged: 1
      },
      per_scenario: [],
      ...(overrides.token_economy === undefined ? {} : { token_economy: overrides.token_economy })
    }
  };
}

async function writeKpi(
  historyRoot: string,
  benchName: string,
  slug: string,
  payload: unknown
): Promise<void> {
  const dir = path.join(historyRoot, benchName, slug);
  await mkdir(dir, { recursive: true });
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  await writeFile(path.join(dir, "kpi.json"), body, "utf8");
}

async function writeDiagnostics(
  historyRoot: string,
  benchName: string,
  slug: string,
  payload: unknown
): Promise<void> {
  const dir = path.join(historyRoot, benchName, slug);
  await mkdir(dir, { recursive: true });
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  await writeFile(path.join(dir, "longmemeval-diagnostics.json"), body, "utf8");
}

function listenLoopback(
  historyRoot: string,
  staticRoot: string
): Promise<{ readonly server: ServerType; readonly origin: string }> {
  const app = createInspectorApp({
    token: "token",
    workspaceId: "ws1",
    daemonUrl: "http://daemon.local",
    benchHistoryRoot: historyRoot,
    staticRoot,
    fetchImpl: async () => Response.json({}, { status: 500 })
  });
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0
      },
      (info) => {
        resolve({ server, origin: `http://127.0.0.1:${info.port}` });
      }
    );
    server.once("error", reject);
  });
}

function closeServer(server: ServerType): Promise<void> {
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function fetchJson(url: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, {
    headers: {
      cookie: `${INSPECTOR_SESSION_COOKIE}=${INSPECTOR_VITEST_SESSION_ID}`
    }
  });
  return { status: response.status, body: await response.json() };
}
