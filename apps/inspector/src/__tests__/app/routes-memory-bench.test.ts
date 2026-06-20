import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInspectorApp,
  INSPECTOR_ROUTE_SURFACE,
  MAX_INSPECTOR_REQUEST_BODY_BYTES
} from "../../runtime/app.js";

import {
  authenticatedRequest,
  createChunkedJsonRequest,
  createEmptyChunkedJsonRequest,
  createNeverEndingChunkedJsonRequest,
  withResponseTimeout
} from "./routes-test-utils.js";

describe("inspector routes", () => {
  it("returns empty bench-summary when the history root does not exist yet", async () => {
    const missing = await mkdtemp(path.join(tmpdir(), "bench-history-empty-"));
    await rm(missing, { recursive: true, force: true });

    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      benchHistoryRoot: missing,
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async () => Response.json({}, { status: 500 })
    });

    const response = await authenticatedRequest(app, "/api/bench-summary");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        self: null,
        public: null,
        public_multiturn: null,
        live: null,
        errors: { self: null, public: null, public_multiturn: null, live: null }
      }
    });
  });


  it("summarizes the latest bench-history entry when one is present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bench-history-with-entries-"));
    const selfRoot = path.join(root, "self", "2026-05-14T100000Z-ec44a05");
    await mkdir(selfRoot, { recursive: true });
    const payload = {
      bench_name: "self",
      split: "synthetic",
      run_at: "2026-05-14T10:00:00.000Z",
      alaya_commit: "ec44a05",
      alaya_version: "0.3.6",
      embedding_provider: "local-heuristic",
      chat_provider: "n/a",
      dataset: { name: "synthetic", size: 12, source: "internal" },
      sample_size: 12,
      evaluated_count: 12,
      harness_mode: "mcp_propose_review",
      kpi: {
        r_at_1: 0.7,
        r_at_5: 0.9,
        r_at_10: 0.93,
        latency_ms_p50: 60,
        latency_ms_p95: 110,
        token_saved_ratio_vs_full_prompt: 0.88,
        tier_distribution: { hot: 50, warm: 30, cold: 20 },
        degradation_reasons: {
          none: 80,
          warm_cascade_engaged: 12,
          cold_cascade_engaged: 8
        },
        per_scenario: []
      }
    };
    await writeFile(path.join(selfRoot, "kpi.json"), JSON.stringify(payload), "utf8");

    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      benchHistoryRoot: root,
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async () => Response.json({}, { status: 500 })
    });

    const response = await authenticatedRequest(app, "/api/bench-summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { self: { history_count: number; latest_slug: string } | null };
    };
    expect(body.data.self?.history_count).toBe(1);
    expect(body.data.self?.latest_slug).toBe("2026-05-14T100000Z-ec44a05");
  });


  it("summarizes public-multiturn bench-history independently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bench-history-multiturn-"));
    const mtRoot = path.join(
      root,
      "public-multiturn",
      "2026-05-15T100000Z-abcdef0"
    );
    await mkdir(mtRoot, { recursive: true });
    await writeFile(
      path.join(mtRoot, "kpi.json"),
      JSON.stringify({
        bench_name: "public-multiturn",
        split: "longmemeval-s",
        run_at: "2026-05-15T10:00:00.000Z",
        alaya_commit: "abcdef0",
        alaya_version: "0.3.8",
        embedding_provider: "none",
        chat_provider: "none",
        dataset: {
          name: "longmemeval_s:multiturn",
          size: 500,
          source: "github:xiaowu0162/LongMemEval"
        },
        sample_size: 500,
        evaluated_count: 10,
        harness_mode: "mcp_propose_review",
        kpi: {
          r_at_1: 0.2,
          r_at_5: 0.6,
          r_at_10: 0.7,
          r_at_5_round_1: 0.4,
          r_at_5_round_2: 0.5,
          r_at_5_round_n: 0.6,
          multiturn_rounds: 3,
          latency_ms_p50: 80,
          latency_ms_p95: 150,
          token_saved_ratio_vs_full_prompt: 0,
          tier_distribution: { hot: 3, warm: 5, cold: 2 },
          degradation_reasons: {
            none: 8,
            warm_cascade_engaged: 1,
            cold_cascade_engaged: 1
          },
          per_scenario: []
        }
      }),
      "utf8"
    );

    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      benchHistoryRoot: root,
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async () => Response.json({}, { status: 500 })
    });

    const response = await authenticatedRequest(app, "/api/bench-summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        public_multiturn: {
          history_count: number;
          latest_slug: string;
          payload: { bench_name: string; kpi: { r_at_5_round_n?: number } };
        } | null;
        errors: { public_multiturn: string | null };
      };
    };
    expect(body.data.errors.public_multiturn).toBeNull();
    expect(body.data.public_multiturn?.history_count).toBe(1);
    expect(body.data.public_multiturn?.latest_slug).toBe(
      "2026-05-15T100000Z-abcdef0"
    );
    expect(body.data.public_multiturn?.payload.bench_name).toBe(
      "public-multiturn"
    );
    expect(body.data.public_multiturn?.payload.kpi.r_at_5_round_n).toBe(0.6);
  });


  it("isolates a malformed kpi.json on one split without wiping the other split", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bench-history-mixed-"));
    const badSelf = path.join(root, "self", "2026-05-14T100000Z-deadbee");
    await mkdir(badSelf, { recursive: true });
    await writeFile(path.join(badSelf, "kpi.json"), "{not valid json", "utf8");

    const goodPublic = path.join(root, "public", "2026-05-14T100000Z-abcdef0");
    await mkdir(goodPublic, { recursive: true });
    const payload = {
      bench_name: "public",
      split: "longmemeval-s",
      run_at: "2026-05-14T10:00:00.000Z",
      alaya_commit: "abcdef0",
      alaya_version: "0.3.6",
      embedding_provider: "yunwu:text-embedding-3-small",
      chat_provider: "yunwu:gpt-5.4-mini",
      dataset: { name: "LongMemEval-S", size: 500, source: "github:xiaowu0162/LongMemEval" },
      sample_size: 500,
      evaluated_count: 500,
      harness_mode: "mcp_propose_review",
      kpi: {
        r_at_1: 0.45,
        r_at_5: 0.72,
        r_at_10: 0.81,
        latency_ms_p50: 90,
        latency_ms_p95: 140,
        token_saved_ratio_vs_full_prompt: 0.83,
        tier_distribution: { hot: 40, warm: 35, cold: 25 },
        degradation_reasons: {
          none: 70,
          warm_cascade_engaged: 18,
          cold_cascade_engaged: 12
        },
        per_scenario: []
      }
    };
    await writeFile(path.join(goodPublic, "kpi.json"), JSON.stringify(payload), "utf8");

    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      benchHistoryRoot: root,
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async () => Response.json({}, { status: 500 })
    });

    const response = await authenticatedRequest(app, "/api/bench-summary");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        self: unknown;
        public: { history_count: number; latest_slug: string } | null;
        public_multiturn: unknown;
        live: unknown;
        errors: {
          self: string | null;
          public: string | null;
          public_multiturn: string | null;
          live: string | null;
        };
      };
    };
    expect(body.data.self).toBeNull();
    expect(body.data.errors.self).toMatch(/kpi_json_invalid|kpi_schema_invalid|summary_failed/);
    expect(body.data.errors.public).toBeNull();
    expect(body.data.public_multiturn).toBeNull();
    expect(body.data.errors.public_multiturn).toBeNull();
    expect(body.data.live).toBeNull();
    expect(body.data.errors.live).toBeNull();
    expect(body.data.public?.history_count).toBe(1);
    expect(body.data.public?.latest_slug).toBe("2026-05-14T100000Z-abcdef0");
  });


  it("returns a 30-day bench trend payload with path expansion shares", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bench-history-trend-"));
    const first = path.join(root, "public", "2026-05-14T100000Z-aaaaaaa");
    const second = path.join(root, "public", "2026-05-15T100000Z-bbbbbbb");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });

    const basePayload = {
      bench_name: "public",
      split: "longmemeval-s",
      alaya_commit: "aaaaaaa",
      alaya_version: "0.3.10",
      embedding_provider: "none",
      chat_provider: "none",
      policy_shape: "stress",
      simulate_report: "none",
      dataset: { name: "LongMemEval-S", size: 500, source: "github:xiaowu0162/LongMemEval" },
      sample_size: 500,
      evaluated_count: 100,
      harness_mode: "mcp_propose_review",
      kpi: {
        r_at_1: 0.2,
        r_at_5: 0.6,
        r_at_10: 0.7,
        latency_ms_p50: 80,
        latency_ms_p95: 150,
        token_saved_ratio_vs_full_prompt: 0.8,
        tier_distribution: { hot: 3, warm: 5, cold: 2 },
        degradation_reasons: {
          none: 8,
          warm_cascade_engaged: 1,
          cold_cascade_engaged: 1
        },
        per_scenario: []
      }
    };
    await writeFile(
      path.join(first, "kpi.json"),
      JSON.stringify({ ...basePayload, run_at: "2026-05-14T10:00:00.000Z" }),
      "utf8"
    );
    await writeFile(
      path.join(second, "kpi.json"),
      JSON.stringify({
        ...basePayload,
        alaya_commit: "bbbbbbb",
        run_at: "2026-05-15T10:00:00.000Z",
        kpi: { ...basePayload.kpi, r_at_5: 0.72, latency_ms_p95: 130 }
      }),
      "utf8"
    );
    await writeFile(
      path.join(second, "longmemeval-diagnostics.json"),
      JSON.stringify({
        scored_recall_evidence: {
          delivered_result_count: 10,
          path_expansion_plane_count: 3,
          graph_expansion_plane_count: 2
        }
      }),
      "utf8"
    );

    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      benchHistoryRoot: root,
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async () => Response.json({}, { status: 500 })
    });

    const response = await authenticatedRequest(app, "/api/bench-trend?limit=30");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly data: {
        readonly public: {
          readonly history_count: number;
          readonly points: readonly {
            readonly slug: string;
            readonly r_at_5: number;
            readonly path_expansion_share: number | null;
            readonly graph_expansion_share: number | null;
          }[];
        };
        readonly errors: { readonly public: string | null };
      };
    };
    expect(body.data.errors.public).toBeNull();
    expect(body.data.public.history_count).toBe(2);
    expect(body.data.public.points.map((point) => point.slug)).toEqual([
      "2026-05-14T100000Z-aaaaaaa",
      "2026-05-15T100000Z-bbbbbbb"
    ]);
    expect(body.data.public.points[1]).toMatchObject({
      r_at_5: 0.72,
      path_expansion_share: 0.3,
      graph_expansion_share: 0.2
    });
  });


  it("rejects workspace-scoped API paths when the Inspector app is missing its launch workspace", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const response = await authenticatedRequest(app, "/api/graph/ws1");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "workspace_binding_missing" });
    expect(calls).toEqual([]);
  });
});
