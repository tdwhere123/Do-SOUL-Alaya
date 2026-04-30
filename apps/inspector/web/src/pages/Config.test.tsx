import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ConfigPage from "./Config";
import { ToastProvider } from "../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../api";

function renderConfig() {
  return render(
    <MemoryRouter initialEntries={["/config"]}>
      <ToastProvider>
        <ConfigPage />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("ConfigPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ success: true, requires_daemon_restart: true });
      }
      if (url.endsWith("/config/ws-1/soul")) {
        return jsonResponse({
          memory_consolidation_enabled: true,
          auto_checkpoint: true
        });
      }
      if (url.endsWith("/config/ws-1/strategy")) {
        return jsonResponse({ auto_approve_readonly: false });
      }
      if (url.endsWith("/config/ws-1/environment")) {
        return jsonResponse({ worktree_enabled: false, env_vars: {} });
      }
      if (url.endsWith("/config/ws-1/embedding-supplement")) {
        return jsonResponse({
          provider_url: null,
          model_id: null,
          secret_ref: null,
          embedding_enabled: false
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toggles dirty indicator from morandi-green to amber when a field changes", async () => {
    renderConfig();
    const dot = await screen.findByTestId("dirty-dot-soul");
    await waitFor(() => expect(dot.className).toContain("morandi-green"));
    const toggles = screen.getAllByRole("button", { pressed: true });
    expect(toggles.length).toBeGreaterThan(0);
    await act(async () => {
      await userEvent.click(toggles[0]);
    });
    await waitFor(() => expect(dot.className).toContain("#C9A36F"));
  });

  it("shows restart banner after PATCH that returns requires_daemon_restart", async () => {
    renderConfig();
    const dot = await screen.findByTestId("dirty-dot-soul");
    await waitFor(() => screen.getByText(/auto checkpoint/i));
    const soulHeading = screen.getByRole("heading", { name: /Soul Runtime/i });
    const soulSection = soulHeading.closest("div.mb-12") as HTMLElement;
    const toggles = within(soulSection).getAllByRole("button", { pressed: true });
    await act(async () => {
      await userEvent.click(toggles[0]);
    });
    await waitFor(() => expect(dot.className).toContain("#C9A36F"));
    const commit = within(soulSection).getByRole("button", { name: /commit changes/i });
    await act(async () => {
      await userEvent.click(commit);
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Restart Daemon Pending/i)
    );
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
