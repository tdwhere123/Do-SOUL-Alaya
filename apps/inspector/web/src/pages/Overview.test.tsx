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
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
