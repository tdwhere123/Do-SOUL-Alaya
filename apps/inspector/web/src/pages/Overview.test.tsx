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
      if (url.includes("/status")) {
        return jsonResponse({ success: true, data: VALID_STATUS });
      }
      if (url.includes("/bench-summary")) {
        return jsonResponse({
          success: true,
          data: { self: null, public: null }
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

  it("renders the four summary cards", async () => {
    renderOverview();
    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(screen.getByTestId("overview-card-proposals")).toBeTruthy();
    expect(screen.getByTestId("overview-card-recall")).toBeTruthy();
    expect(screen.getByTestId("overview-card-tier")).toBeTruthy();
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
          data: { self: null, public: null }
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

  it("renders both Latest Bench cards with an empty placeholder when no entries exist", async () => {
    renderOverview();
    expect(await screen.findByTestId("overview-bench-self-empty")).toBeTruthy();
    expect(screen.getByTestId("overview-bench-public-empty")).toBeTruthy();
    expect(screen.getByTestId("overview-bench-self-empty").textContent).toMatch(
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
              latest_slug: "2026-05-14-ec44a05",
              history_count: 3,
              payload: {
                bench_name: "self",
                split: "synthetic",
                run_at: "2026-05-14T10:00:00.000Z",
                kpi: { r_at_5: 0.912 }
              },
              diff: {
                previous_slug: "2026-05-12-aaaaaaa",
                worst_verdict: "warn",
                r_at_5_delta_pp: -2.1
              }
            },
            public: null
          }
        });
      }
      return jsonResponse({}, 404);
    });

    renderOverview();
    const selfCard = await screen.findByTestId("overview-bench-self");
    expect(selfCard.textContent).toContain("91.2%");
    expect(selfCard.textContent).toMatch(/-2.1pp/);
    expect(selfCard.textContent).toContain("3 historical entries");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
