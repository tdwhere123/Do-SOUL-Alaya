import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OverviewPage from "./Overview";
import { ToastProvider } from "../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../api";

function renderOverview() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <OverviewPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

const VALID_STATUS = {
  checked_at: "2026-05-14T12:00:00.000Z",
  daemon: {
    ready: true,
    startup_steps: ["repo opened", "routes registered"],
    principal_coding_engine_available: true
  },
  mcp: { enrolled_tools: 9, allowed_servers: ["soul"] }
};

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("OverviewPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("t");
    setWorkspaceId("ws1");
    fetchMock = vi.fn();
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/proposals/ws1/pending")) {
        return jsonResponse({
          success: true,
          data: { proposals: [], total_count: 5 }
        });
      }
      if (url.includes("/recall-stats/ws1")) {
        return jsonResponse({
          success: true,
          data: { recall: { total: 42 }, usage: { used_ratio: 0.5 } }
        });
      }
      if (url.includes("/status")) {
        return jsonResponse({ success: true, data: VALID_STATUS });
      }
      if (url.includes("/bench-summary")) {
        return jsonResponse({
          success: true,
          data: {
            self: null,
            public: null,
            public_multiturn: null,
            live: null,
            errors: { self: null, public: null, public_multiturn: null, live: null }
          }
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null);
  });

  it("renders the three summary cards", async () => {
    renderOverview();
    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(screen.getByTestId("overview-card-proposals")).toBeTruthy();
    expect(screen.getByTestId("overview-card-recall")).toBeTruthy();
    expect(screen.queryByTestId("overview-card-tier")).toBeNull();
  });

  it("wires the recall card to the live recall-stats used-ratio", async () => {
    renderOverview();
    await waitFor(() =>
      expect(screen.getByTestId("overview-card-recall").textContent).toContain("50.0%")
    );
    expect(screen.getByTestId("overview-card-recall").textContent).toContain("42");
  });

  it("shows OPERATIONAL when daemon.ready=true", async () => {
    renderOverview();
    await waitFor(() =>
      expect(screen.getByTestId("overview-health-indicator").textContent).toMatch(
        /OPERATIONAL/i
      )
    );
  });

  it("shows the pending memory count returned by the daemon", async () => {
    renderOverview();
    await waitFor(() =>
      expect(screen.getByTestId("overview-card-proposals").textContent).toContain("5")
    );
  });

  it("falls back to em-dash when the pending fetch fails", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/proposals/ws1/pending")) {
        return new Response("boom", { status: 500 });
      }
      if (url.includes("/status")) {
        return jsonResponse({ success: true, data: VALID_STATUS });
      }
      if (url.includes("/bench-summary")) {
        return jsonResponse({
          success: true,
          data: {
            self: null,
            public: null,
            public_multiturn: null,
            live: null,
            errors: { self: null, public: null, public_multiturn: null, live: null }
          }
        });
      }
      return jsonResponse({}, 404);
    });

    renderOverview();
    await waitFor(() =>
      expect(screen.getByTestId("overview-health-indicator").textContent).toMatch(
        /OPERATIONAL/i
      )
    );
    expect(screen.getByTestId("overview-card-proposals").textContent).toContain("—");
  });

  it("renders all Latest Bench cards with an empty placeholder when no entries exist", async () => {
    renderOverview();
    await waitFor(() =>
      expect(screen.getByTestId("overview-bench-self-empty").textContent).toMatch(
        /no benchmark entries yet/i
      )
    );
    expect(screen.getByTestId("overview-bench-public-empty").textContent).toMatch(
      /no benchmark entries yet/i
    );
    expect(screen.getByTestId("overview-bench-public-multiturn-empty").textContent).toMatch(
      /no benchmark entries yet/i
    );
    expect(screen.getByTestId("overview-bench-live-empty").textContent).toMatch(
      /no benchmark entries yet/i
    );
  });

  it("renders the latest R@5 + delta when a self-bench entry is present", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/proposals/ws1/pending")) {
        return jsonResponse({ success: true, data: { proposals: [], total_count: 0 } });
      }
      if (url.includes("/status")) {
        return jsonResponse({ success: true, data: VALID_STATUS });
      }
      if (url.includes("/bench-summary")) {
        return jsonResponse({
          success: true,
          data: {
            self: {
              latest_slug: "2026-05-14T100000Z-ec44a05",
              history_count: 3,
              payload: {
                bench_name: "self",
                split: "synthetic",
                run_at: "2026-05-14T10:00:00.000Z",
                kpi: { r_at_5: 0.912 }
              },
              diff: {
                previous_slug: "2026-05-12T100000Z-aaaaaaa",
                worst_verdict: "warn",
                r_at_5_delta_pp: -2.1
              }
            },
            public: null,
            public_multiturn: {
              latest_slug: "2026-05-15T100000Z-abcdef0",
              history_count: 2,
              payload: {
                bench_name: "public-multiturn",
                split: "longmemeval-s",
                run_at: "2026-05-15T10:00:00.000Z",
                kpi: { r_at_5: 0.634 }
              },
              diff: {
                previous_slug: "2026-05-14T100000Z-bbbbbbb",
                worst_verdict: "ok",
                r_at_5_delta_pp: 3.4
              }
            },
            live: {
              latest_slug: "2026-05-12T053953Z-ec44a05",
              history_count: 1,
              payload: {
                bench_name: "live",
                split: "strict-real",
                run_at: "2026-05-12T05:39:53.229Z",
                kpi: { r_at_5: 0.946 }
              },
              diff: {
                previous_slug: null,
                worst_verdict: "ok",
                r_at_5_delta_pp: null
              }
            },
            errors: { self: null, public: null, public_multiturn: null, live: null }
          }
        });
      }
      return jsonResponse({}, 404);
    });

    renderOverview();
    await waitFor(() =>
      expect(screen.getByTestId("overview-bench-self").textContent).toContain("91.2%")
    );
    const selfCard = screen.getByTestId("overview-bench-self");
    expect(selfCard.textContent).toContain("91.2%");
    expect(selfCard.textContent).toMatch(/-2.1pp/);
    expect(selfCard.textContent).toContain("3 historical entries");
    expect(screen.getByTestId("overview-bench-public-multiturn").textContent).toContain("63.4%");
    expect(screen.getByTestId("overview-bench-public-multiturn").textContent).toMatch(/\+3.4pp/);
    expect(screen.getByTestId("overview-bench-live").textContent).toContain("94.6%");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
