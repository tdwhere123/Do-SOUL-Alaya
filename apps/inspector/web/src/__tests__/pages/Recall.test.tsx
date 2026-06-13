import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import RecallPage from "../../pages/Recall";
import { ToastProvider } from "../../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../../api";

function renderRecall() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <RecallPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

const SAMPLE_STATS = {
  window: {
    workspace_id: "ws1",
    since: "2026-05-07T00:00:00.000Z",
    until: null,
    excluded_agent_targets: ["inspector", "cli", "tools-cli"]
  },
  recall: {
    total: 42,
    unique_sessions: 12,
    unique_runs: 9,
    null_run: 1,
    miss_count: 4,
    miss_ratio: 0.0952,
    p50_pointer_count: 3,
    p50_latency_ms: 120
  },
  embedding: {
    total_queries: 3,
    returned_candidate_count: 5,
    p50_latency_ms: 280,
    p95_latency_ms: 900,
    p99_latency_ms: 1250,
    latency_buckets: [
      { label: "<=150ms", count: 1 },
      { label: "<=300ms", count: 1 },
      { label: "<=800ms", count: 0 },
      { label: "<=1100ms", count: 0 },
      { label: ">1100ms", count: 1 }
    ]
  },
  usage: {
    total: 30,
    used: 18,
    skipped: 8,
    not_applicable: 4,
    used_ratio: 0.6,
    follow_through_ratio: 0.714
  }
};

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("RecallPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("t");
    setWorkspaceId("ws1");
    fetchMock = vi.fn();
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/recall-stats/ws1")) {
        return jsonResponse({ success: true, data: SAMPLE_STATS });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null);
  });

  it("renders the six KPI cards from the daemon stats payload", async () => {
    renderRecall();
    expect(await screen.findByTestId("recall-kpi-total")).toBeTruthy();
    expect(screen.getByTestId("recall-kpi-total").textContent).toContain("42");
    expect(screen.getByTestId("recall-kpi-sessions").textContent).toContain("12");
    expect(screen.getByTestId("recall-kpi-runs").textContent).toContain("9");
    expect(screen.getByTestId("recall-kpi-miss").textContent).toContain("9.5%");
    expect(screen.getByTestId("recall-kpi-used").textContent).toContain("60.0%");
    expect(screen.getByTestId("recall-kpi-follow").textContent).toContain("71.4%");
    expect(screen.getByText("embedding queries").parentElement?.textContent).toContain("3");
    expect(screen.getByText("embedding latency").parentElement?.textContent).toContain(
      "p50 280 / p95 900 / p99 1250 ms"
    );
  });

  it("includes a since query parameter on the daemon request", async () => {
    renderRecall();
    await waitFor(() => {
      const called = fetchMock.mock.calls.some((call) => {
        const url = urlOf(call[0] as FetchInput);
        return url.includes("/recall-stats/ws1") && url.includes("since=");
      });
      expect(called).toBe(true);
    });
  });

  it("requeries when the window toggle changes", async () => {
    renderRecall();
    await screen.findByTestId("recall-kpi-total");
    const callsBefore = fetchMock.mock.calls.length;
    const toggle = screen.getByRole("group", { name: /recall window/i });
    const dayButton = await screen.findByRole("button", { pressed: false, name: /24h/i });
    await userEvent.click(dayButton);
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    expect(toggle).toBeTruthy();
  });

  it("renders the workspace-missing alert without fetching", async () => {
    setWorkspaceId(null);
    renderRecall();
    expect(await screen.findByTestId("recall-no-workspace")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a recall-error block when the daemon returns 500", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes("/recall-stats/ws1")) {
        return new Response("server boom", { status: 500 });
      }
      return jsonResponse({}, 404);
    });
    renderRecall();
    await waitFor(
      () => expect(screen.getByTestId("recall-error")).toBeTruthy(),
      { timeout: 5000 }
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
