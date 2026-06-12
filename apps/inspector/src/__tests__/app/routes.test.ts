import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInspectorApp, INSPECTOR_ROUTE_SURFACE } from "../../runtime/app.js";

describe("inspector routes", () => {
  it("pins the frozen backend route surface", () => {
    expect([...INSPECTOR_ROUTE_SURFACE]).toEqual([
      "GET /api/config/:workspaceId/soul",
      "PATCH /api/config/:workspaceId/soul",
      "GET /api/config/:workspaceId/strategy",
      "PATCH /api/config/:workspaceId/strategy",
      "GET /api/config/:workspaceId/environment",
      "PATCH /api/config/:workspaceId/environment",
      "GET /api/config/:workspaceId/embedding-supplement",
      "PATCH /api/config/runtime/embedding-supplement",
      "GET /api/config/:workspaceId/garden-compute",
      "PATCH /api/config/runtime/garden-compute",
      "GET /api/config/:workspaceId/manifestation-budget",
      "PATCH /api/config/:workspaceId/manifestation-budget",
      "GET /api/bench-summary",
      "GET /api/bench-trend",
      "GET /api/embedding-status/:workspaceId",
      "GET /api/graph/:workspaceId",
      "GET /api/workspaces/:workspaceId/health-inbox",
      "GET /api/memory-entries/:workspaceId",
      "GET /api/pointers/:workspaceId/:objectId",
      "GET /api/recall-stats/:workspaceId",
      "GET /api/status",
      // Inspector loopback routes share the attached-agent proposal review
      // workflow for pending-proposals listing plus accept/reject.
      "GET /api/proposals/:workspaceId/pending",
      "POST /api/proposals/:workspaceId/:proposalId/review",
      "POST /api/proposals/:workspaceId/memory/:memoryId/keep",
      "POST /api/proposals/:workspaceId/memory/:memoryId/rewrite",
      "POST /api/proposals/:workspaceId/memory/:memoryId/downgrade",
      "POST /api/proposals/:workspaceId/memory/:memoryId/retire",
      "POST /api/workspaces/:workspaceId/soul/memory/:memoryId/proposals/promote-strictly-governed",
      "POST /api/soul/search/:workspaceId"
    ]);
  });

  it("proxies config, graph, status, and embedding-supplement routes to daemon HTTP without importing daemon code", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : String(init.body)
        });
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    await app.request("/api/config/ws1/soul?token=token");
    await app.request("/api/config/ws1/embedding-supplement?token=token");
    await app.request("/api/config/runtime/embedding-supplement?token=token", {
      method: "PATCH",
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/config/ws1/garden-compute?token=token");
    await app.request("/api/config/runtime/garden-compute?token=token", {
      method: "PATCH",
      body: JSON.stringify({
        provider_kind: "official_api",
        secret_ref_mode: "env",
        secret_value: "ALAYA_OFFICIAL_GARDEN_API_KEY"
      }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/config/ws1/manifestation-budget?token=token");
    await app.request("/api/config/ws1/manifestation-budget?token=token", {
      method: "PATCH",
      body: JSON.stringify({ stance_bias_cap: 8 }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/config/ws1/strategy?token=token", {
      method: "PATCH",
      body: JSON.stringify({ auto_approve_readonly: true }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/graph/ws1?token=token");
    await app.request(
      "/api/recall-stats/ws1?token=token&since=2026-05-01T00:00:00Z&until=2026-05-08T00:00:00Z&excludeAgentTargets=inspector,cli"
    );
    await app.request("/api/status?token=token");

    expect(calls).toEqual([
      { url: "http://daemon.local/workspaces/ws1/config/soul", method: "GET", body: null },
      { url: "http://daemon.local/config/runtime/embedding-supplement", method: "GET", body: null },
      {
        url: "http://daemon.local/config/runtime/embedding-supplement",
        method: "PATCH",
        body: "{\"secret_ref_mode\":\"paste\",\"secret_value\":\"sk-test-plaintext-secret\"}"
      },
      { url: "http://daemon.local/config/runtime/garden-compute", method: "GET", body: null },
      {
        url: "http://daemon.local/config/runtime/garden-compute",
        method: "PATCH",
        body: "{\"provider_kind\":\"official_api\",\"secret_ref_mode\":\"env\",\"secret_value\":\"ALAYA_OFFICIAL_GARDEN_API_KEY\"}"
      },
      {
        url: "http://daemon.local/workspaces/ws1/config/manifestation-budget",
        method: "GET",
        body: null
      },
      {
        url: "http://daemon.local/workspaces/ws1/config/manifestation-budget",
        method: "PATCH",
        body: "{\"stance_bias_cap\":8}"
      },
      {
        url: "http://daemon.local/workspaces/ws1/config/strategy",
        method: "PATCH",
        body: "{\"auto_approve_readonly\":true}"
      },
      { url: "http://daemon.local/workspaces/ws1/path-graph", method: "GET", body: null },
      {
        url: "http://daemon.local/workspaces/ws1/recall-stats?since=2026-05-01T00%3A00%3A00Z&until=2026-05-08T00%3A00%3A00Z&excludeAgentTargets=inspector%2Ccli",
        method: "GET",
        body: null
      },
      { url: "http://daemon.local/status", method: "GET", body: null }
    ]);
  });

  it("loads embedding-supplement config from the daemon runtime config endpoint", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      fetchImpl: async (input) => {
        if (String(input).endsWith("/workspaces/ws1/embedding-status")) {
          return Response.json({
            success: true,
            data: {
              workspace_id: "ws1",
              embedding_enabled: false,
              provider_configured: false,
              model_id: "text-embedding-3-small",
              storage_available: true,
              effective_mode: "keyword_only",
              degraded_reason: null,
              checked_at: "2026-05-01T00:00:00.000Z"
            }
          });
        }
        return Response.json({
          success: true,
          data: {
            provider_url: "https://embedding.example.test/v1",
            secret_ref: "file:/home/alaya/.config/alaya/secrets/openai",
            model_id: "text-embedding-3-small",
            embedding_enabled: true
          }
        });
      }
    });

    const response = await app.request("/api/config/ws1/embedding-supplement?token=token");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        provider_url: "https://embedding.example.test/v1",
        secret_ref: "file:/home/alaya/.config/alaya/secrets/openai",
        model_id: "text-embedding-3-small",
        embedding_enabled: true
      }
    });
  });

  it("sanitizes daemon upstream errors", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => Response.json({ error: "/secret/path" }, { status: 503 })
    });

    const response = await app.request("/api/status?token=token");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "daemon_503" });
  });

  it("returns daemon unavailable when the daemon fetch fails", async () => {
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5173"), {
          code: "ECONNREFUSED"
        });
      }
    });

    const response = await app.request("/api/graph/ws1?token=token");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "daemon_unavailable" });
  });

  it("sanitizes daemon validation errors for embedding paste requests", async () => {
    const plaintext = "sk-test-leaked-secret";
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => Response.json({ error: `validation failed: ${plaintext}` }, { status: 400 })
    });

    const response = await app.request("/api/config/runtime/embedding-supplement?token=token", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: plaintext
      })
    });

    expect(response.status).toBe(400);
    const bodyText = await response.text();
    expect(bodyText).toBe("{\"error\":\"daemon_400\"}");
    expect(bodyText).not.toContain(plaintext);
    expect(bodyText).not.toContain("validation failed");
  });

  it("sanitizes daemon fetch failures without echoing stack or plaintext", async () => {
    const plaintext = "sk-test-plaintext-secret";
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () => {
        throw new Error(`boom ${plaintext}`);
      }
    });

    const response = await app.request("/api/config/runtime/embedding-supplement?token=token", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret_ref_mode: "paste",
        secret_value: plaintext
      })
    });

    expect(response.status).toBe(503);
    const bodyText = await response.text();
    expect(bodyText).toBe("{\"error\":\"daemon_unavailable\"}");
    expect(bodyText).not.toContain(plaintext);
    expect(bodyText).not.toContain("Error:");
  });

  it("serves static files, rejects traversal, and tolerates a missing frontend bundle", async () => {
    const staticRoot = await mkdtemp(path.join(tmpdir(), "inspector-static-"));
    await mkdir(path.join(staticRoot, "assets"));
    await writeFile(path.join(staticRoot, "index.html"), "<html>ok</html>", "utf8");
    await writeFile(path.join(staticRoot, "assets", "app.js"), "console.log('ok');", "utf8");
    const app = createInspectorApp({ token: "token", staticRoot });

    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/api/status")).status).toBe(401);
    expect(await (await app.request("/?token=token")).text()).toContain("<html>ok</html>");
    expect(await (await app.request("/assets/app.js")).text()).toContain("console.log");
    expect((await app.request("/..%2F..%2Fetc%2Fpasswd?token=token")).status).toBe(404);

    const missingApp = createInspectorApp({
      token: "token",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-missing-"))
    });
    const missingResponse = await missingApp.request("/?token=token");
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.json()).toEqual({ error: "frontend_bundle_missing" });
  });

  // Inspector forwards proposal review calls to the daemon's
  // workspace-scoped HTTP wrapper around the MCP handler. The Inspector
  // backend itself never imports daemon code.
  it("proxies pending-proposals listing and accept/reject through to the daemon", async () => {
    const calls: {
      url: string;
      method: string;
      body: string | null;
      requestToken: string | null;
      desktop: string | null;
    }[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      env: {
        ALAYA_REQUEST_TOKEN: "daemon-request-token",
        ALAYA_REVIEWER_TOKEN: "review-token",
        ALAYA_REVIEWER_IDENTITY: "user:local-reviewer"
      },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : String(init.body),
          requestToken: headers.get("x-request-token"),
          desktop: headers.get("x-alaya-desktop")
        });
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    await app.request("/api/proposals/ws1/pending?token=token&limit=10");
    await app.request("/api/proposals/ws1/prop-1/review?token=token", {
      method: "POST",
      body: JSON.stringify({
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:payload"
      }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/proposals/ws1/memory/mem-1/rewrite?token=token", {
      method: "POST",
      body: JSON.stringify({ new_content: "rewritten memory" }),
      headers: { "content-type": "application/json" }
    });
    await app.request("/api/proposals/ws1/memory/mem-1/retire?token=token", {
      method: "POST"
    });

    expect(calls).toEqual([
      {
        url: "http://daemon.local/workspaces/ws1/proposals/pending?limit=10",
        method: "GET",
        body: null,
        requestToken: null,
        desktop: null
      },
      {
        url: "http://daemon.local/workspaces/ws1/proposals/prop-1/review",
        method: "POST",
        body: "{\"verdict\":\"accept\",\"reason\":\"looks right\",\"reviewer_identity\":\"user:local-reviewer\",\"reviewer_token\":\"review-token\"}",
        requestToken: "daemon-request-token",
        desktop: "1"
      },
      {
        url: "http://daemon.local/workspaces/ws1/soul/memory/mem-1/proposals/rewrite",
        method: "POST",
        body: "{\"new_content\":\"rewritten memory\"}",
        requestToken: "daemon-request-token",
        desktop: "1"
      },
      {
        url: "http://daemon.local/workspaces/ws1/soul/memory/mem-1/proposals/retire",
        method: "POST",
        body: null,
        requestToken: "daemon-request-token",
        desktop: "1"
      }
    ]);
  });

  // Inspector forwards the Health Inbox projection GET and the
  // promote-to-strictly_governed proposal POST to the daemon's
  // workspace-scoped HTTP endpoints without importing daemon code.
  it("proxies health-inbox and promote-strictly-governed through to the daemon", async () => {
    const calls: {
      url: string;
      method: string;
      body: string | null;
      requestToken: string | null;
    }[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      staticRoot: await mkdtemp(path.join(tmpdir(), "inspector-static-")),
      env: { ALAYA_REQUEST_TOKEN: "daemon-request-token" },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body === undefined ? null : String(init.body),
          requestToken: headers.get("x-request-token")
        });
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    await app.request("/api/workspaces/ws1/health-inbox?token=token&state=pending");
    await app.request(
      "/api/workspaces/ws1/soul/memory/mem-1/proposals/promote-strictly-governed?token=token",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" }
      }
    );

    expect(calls).toEqual([
      {
        url: "http://daemon.local/workspaces/ws1/health-inbox?state=pending",
        method: "GET",
        body: null,
        requestToken: null
      },
      {
        url: "http://daemon.local/workspaces/ws1/soul/memory/mem-1/proposals/promote-strictly-governed",
        method: "POST",
        body: "{}",
        requestToken: "daemon-request-token"
      }
    ]);
  });

  it("rejects health-inbox and promote paths that do not match the launch workspace", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const healthInbox = await app.request("/api/workspaces/ws2/health-inbox?token=token");
    const promote = await app.request(
      "/api/workspaces/ws2/soul/memory/mem-1/proposals/promote-strictly-governed?token=token",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );

    expect(healthInbox.status).toBe(403);
    expect(promote.status).toBe(403);
    await expect(healthInbox.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(promote.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([]);
  });

  it("rejects workspace-scoped API paths that do not match the launch workspace", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const graph = await app.request("/api/graph/ws2?token=token");
    const graphWhitespace = await app.request("/api/graph/ws1%20?token=token");
    const config = await app.request("/api/config/ws2/strategy?token=token");
    const proposals = await app.request("/api/proposals/ws2/pending?token=token");
    const recallStats = await app.request("/api/recall-stats/ws2?token=token");
    const search = await app.request("/api/soul/search/ws2?token=token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "memory" })
    });
    const memoryList = await app.request("/api/memory-entries/ws2?token=token");
    const pointer = await app.request("/api/pointers/ws2/evidence-1?token=token");

    expect(graph.status).toBe(403);
    expect(graphWhitespace.status).toBe(403);
    expect(config.status).toBe(403);
    expect(proposals.status).toBe(403);
    expect(recallStats.status).toBe(403);
    expect(search.status).toBe(403);
    expect(memoryList.status).toBe(403);
    expect(pointer.status).toBe(403);
    await expect(graph.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(graphWhitespace.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(recallStats.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(memoryList.json()).resolves.toEqual({ error: "workspace_forbidden" });
    await expect(pointer.json()).resolves.toEqual({ error: "workspace_forbidden" });
    expect(calls).toEqual([]);
  });

  it("proxies pointer fetch through the workspace-scoped daemon evidence path with URL-encoded object id", async () => {
    const calls: string[] = [];
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return Response.json({ success: true, data: { object_id: "obj/1", gist: "g", excerpt: "e" } });
      }
    });
    const response = await app.request("/api/pointers/ws1/obj%2F1?token=token");
    expect(response.status).toBe(200);
    expect(calls).toEqual(["http://daemon.local/workspaces/ws1/evidence/obj%2F1"]);
  });

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

    const response = await app.request("/api/bench-summary?token=token");
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

    const response = await app.request("/api/bench-summary?token=token");
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

    const response = await app.request("/api/bench-summary?token=token");
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

    const response = await app.request("/api/bench-summary?token=token");
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

    const response = await app.request("/api/bench-trend?token=token&limit=30");
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

    const response = await app.request("/api/graph/ws1?token=token");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "workspace_binding_missing" });
    expect(calls).toEqual([]);
  });
});
