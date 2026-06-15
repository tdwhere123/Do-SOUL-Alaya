import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppContent } from "../../app/App";
import { ToastProvider } from "../../components/Toast";
import { LocaleProvider } from "../../i18n/Locale";
import { getWorkspaceId, setInspectorToken, setWorkspaceId } from "../../api";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function renderApp(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocaleProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  );
}

describe("AppContent", () => {
  beforeEach(() => {
    setInspectorToken("");
    setWorkspaceId(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput) => {
        const url = urlOf(input);

        if (url.includes("/status")) {
          return jsonResponse({ success: true, data: VALID_STATUS });
        }

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
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkspaceId(null);
  });

  it("keeps the launch token after redirecting from / to the real overview surface", async () => {
    renderApp("/?workspaceId=ws1#token=test-token");

    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(screen.getByTestId("overview-card-proposals").textContent).toContain("5");
    expect(screen.getByTestId("inspector-sidebar")).toBeTruthy();
    expect(screen.queryByText("No token found in URL. Please run `alaya inspect` to open this tool.")).toBeNull();
  });

  it("renders the real legacy /status redirect through the system surface", async () => {
    renderApp("/status?workspaceId=ws1#token=test-token");

    expect(await screen.findByText("Startup Log")).toBeTruthy();
    expect(screen.getByText("repo opened")).toBeTruthy();
    expect(screen.getByTestId("system-tabs")).toBeTruthy();
  });

  it("clears stale workspace state when a fresh token URL omits workspaceId", async () => {
    setWorkspaceId("stale-ws");

    renderApp("/#token=fresh-token");

    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(getWorkspaceId()).toBeNull();
  });

  it("renders the lazy graph route through the app router", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);

    renderApp("/graph#token=test-token");

    expect(await screen.findByTestId("graph-no-workspace")).toBeTruthy();
    expect(
      screen.getByText("No workspaceId in URL. Re-run `alaya inspect` with --workspace.")
    ).toBeTruthy();
  });
});
