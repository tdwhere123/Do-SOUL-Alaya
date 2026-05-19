import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import BenchTrendPage from "./BenchTrend";
import { LocaleProvider } from "../i18n/Locale";
import { setInspectorToken, setWorkspaceId } from "../api";

function renderBenchTrend() {
  return render(
    <LocaleProvider>
      <BenchTrendPage />
    </LocaleProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("BenchTrendPage", () => {
  beforeEach(() => {
    setInspectorToken("t");
    setWorkspaceId("ws1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null);
  });

  it("renders trend panels from bench-trend API data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          data: {
            public: {
              bench_name: "public",
              history_count: 2,
              points: [
                {
                  slug: "2026-05-14T100000Z-aaaaaaa",
                  bench_name: "public",
                  split: "longmemeval-s",
                  run_at: "2026-05-14T10:00:00.000Z",
                  embedding_provider: "none",
                  policy_shape: "stress",
                  simulate_report: "none",
                  evaluated_count: 100,
                  sample_size: 500,
                  r_at_1: 0.2,
                  r_at_5: 0.6,
                  r_at_10: 0.7,
                  latency_ms_p95: 150,
                  token_saved_ratio_vs_full_prompt: 0.8,
                  path_expansion_share: 0.1,
                  graph_expansion_share: 0.05
                },
                {
                  slug: "2026-05-15T100000Z-bbbbbbb",
                  bench_name: "public",
                  split: "longmemeval-s",
                  run_at: "2026-05-15T10:00:00.000Z",
                  embedding_provider: "none",
                  policy_shape: "stress",
                  simulate_report: "none",
                  evaluated_count: 100,
                  sample_size: 500,
                  r_at_1: 0.3,
                  r_at_5: 0.72,
                  r_at_10: 0.82,
                  latency_ms_p95: 130,
                  token_saved_ratio_vs_full_prompt: 0.84,
                  path_expansion_share: 0.3,
                  graph_expansion_share: 0.2
                }
              ]
            },
            public_locomo: null,
            public_multiturn: null,
            public_crossquestion: null,
            self: null,
            live: null,
            errors: {}
          }
        })
      )
    );

    renderBenchTrend();

    const panel = await screen.findByTestId("bench-trend-public");
    expect(panel.textContent).toContain("LongMemEval-S");
    expect(panel.textContent).toContain("72.0%");
    expect(panel.textContent).toContain("82.0%");
    expect(panel.textContent).toContain("130 ms");
    expect(panel.textContent).toContain("30.0%");
  });
});
