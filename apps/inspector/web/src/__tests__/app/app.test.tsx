import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppContent } from "../../app/app";
import { ToastProvider } from "../../components/toast";
import { LocaleProvider } from "../../i18n/locale";
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

function stubInspectorFetch(options?: {
  readonly onLaunchRedeem?: (code: string) => Response;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
    const url = urlOf(input);

    if (url.includes("/api/launch-session") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { readonly code?: string };
      const code = typeof body.code === "string" ? body.code : "";
      if (options?.onLaunchRedeem) {
        return options.onLaunchRedeem(code);
      }
      return jsonResponse({ token: "test-token" });
    }

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
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(initialEntry: string, options?: { readonly strict?: boolean }) {
  const tree = (
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocaleProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </LocaleProvider>
    </MemoryRouter>
  );

  return render(options?.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

function launchRedeemBodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ code: string }> {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      return urlOf(input as FetchInput).includes("/api/launch-session") &&
        (init as RequestInit | undefined)?.method === "POST";
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body ?? "{}")) as { code: string });
}

describe("AppContent", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setInspectorToken("");
    setWorkspaceId(null);
    stubInspectorFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    setWorkspaceId(null);
  });

  it("keeps the launch session after redirecting from / to the real overview surface", async () => {
    const fetchMock = vi.mocked(fetch);
    renderApp("/?workspaceId=ws1&launch=launch-code");

    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(await screen.findByTestId("overview-card-proposals")).toBeTruthy();
    expect(screen.getByTestId("overview-card-proposals").textContent).toContain("5");
    expect(screen.getByTestId("inspector-sidebar")).toBeTruthy();
    expect(screen.queryByText("No session found. Please run `alaya inspect` to open this tool.")).toBeNull();
    expect(launchRedeemBodies(fetchMock)).toEqual([{ code: "launch-code" }]);
  });

  it("renders the real legacy /status redirect through the system surface", async () => {
    renderApp("/status?workspaceId=ws1&launch=launch-code");

    expect(await screen.findByText("Startup Log")).toBeTruthy();
    expect(screen.getByText("repo opened")).toBeTruthy();
    expect(screen.getByTestId("system-tabs")).toBeTruthy();
  });

  it("clears stale workspace state when a fresh launch URL omits workspaceId", async () => {
    setWorkspaceId("stale-ws");

    renderApp("/?launch=fresh-launch-code");

    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(getWorkspaceId()).toBeNull();
  });

  it("renders the lazy graph route through the app router", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);

    renderApp("/graph?launch=launch-code");

    expect(await screen.findByTestId("graph-no-workspace")).toBeTruthy();
    expect(
      screen.getByText("No workspaceId in URL. Re-run `alaya inspect` with --workspace.")
    ).toBeTruthy();
  });

  it("stays ready when a second redeem fails but an existing session token is present", async () => {
    setInspectorToken("existing-token");
    setWorkspaceId("old-ws");
    const fetchMock = stubInspectorFetch({
      onLaunchRedeem: () => jsonResponse({ error: "already redeemed" }, 410)
    });

    renderApp("/?workspaceId=ws1&launch=used-once-code");

    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(
      screen.queryByText("Launch code expired or invalid. Please run `alaya inspect` again.")
    ).toBeNull();
    expect(screen.queryByText("No session found. Please run `alaya inspect` to open this tool.")).toBeNull();
    expect(launchRedeemBodies(fetchMock)).toEqual([{ code: "used-once-code" }]);
    expect(getWorkspaceId()).toBe("ws1");
  });

  it("redeems a launch code only once across StrictMode remounts", async () => {
    let redeemCount = 0;
    stubInspectorFetch({
      onLaunchRedeem: (code) => {
        redeemCount += 1;
        if (redeemCount > 1) {
          return jsonResponse({ error: "already redeemed" }, 410);
        }
        expect(code).toBe("strict-launch-code");
        return jsonResponse({ token: "strict-token" });
      }
    });

    renderApp("/?workspaceId=ws1&launch=strict-launch-code", { strict: true });

    expect(await screen.findByTestId("overview-card-daemon")).toBeTruthy();
    expect(
      screen.queryByText("Launch code expired or invalid. Please run `alaya inspect` again.")
    ).toBeNull();
    expect(redeemCount).toBe(1);
  });
});
