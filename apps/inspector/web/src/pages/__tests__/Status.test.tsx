import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import StatusPage from "../Status";
import { ToastProvider } from "../../components/Toast";
import { setInspectorToken } from "../../api";

function renderStatus() {
  return render(
    <ToastProvider>
      <StatusPage />
    </ToastProvider>
  );
}

const VALID_STATUS = {
  checked_at: "2026-04-30T12:00:00.000Z",
  daemon: {
    ready: true,
    startup_steps: ["repo opened", "routes registered"],
    principal_coding_engine_available: true
  },
  mcp: { enrolled_tools: 7, allowed_servers: ["soul"] }
};

describe("StatusPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("t");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows OPERATIONAL when daemon.ready=true", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: VALID_STATUS })
    );
    renderStatus();
    await waitFor(() => screen.getByText(/OPERATIONAL/i));
  });

  it("shows OFFLINE when daemon.ready=false (no longer misreads as OPERATIONAL)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { ...VALID_STATUS, daemon: { ...VALID_STATUS.daemon, ready: false } }
      })
    );
    renderStatus();
    await waitFor(() => screen.getByText(/OFFLINE/i));
    expect(screen.queryByText("OPERATIONAL")).toBeNull();
  });

  it("shows schema mismatch fallback when daemon returns wrong shape", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { foo: "bar" } }));
    renderStatus();
    await waitFor(() => screen.getByText(/schema mismatch/i));
  });

  it("shows degraded banner on fetch failure", async () => {
    fetchMock.mockResolvedValue(new Response("err", { status: 500 }));
    renderStatus();
    await waitFor(
      () => expect(screen.getByRole("alert").textContent).toMatch(/STATUS_FEED_DEGRADED/i),
      { timeout: 8000 }
    );
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
