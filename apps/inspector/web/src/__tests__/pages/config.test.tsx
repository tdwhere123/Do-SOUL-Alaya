import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ConfigPage from "../../pages/config";
import { ToastProvider } from "../../components/toast";
import { LocaleProvider } from "../../i18n/locale";
import { setInspectorToken, setWorkspaceId } from "../../api";

function renderConfig() {
  return render(
    <MemoryRouter initialEntries={["/config"]}>
      <LocaleProvider>
        <ToastProvider>
          <ConfigPage />
        </ToastProvider>
      </LocaleProvider>
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
        return jsonResponse({
          auto_approve_readonly: false,
          config_version: "2026-06-14"
        });
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
      if (url.endsWith("/config/ws-1/manifestation-budget")) {
        return jsonResponse({
          success: true,
          data: {
            workspace_id: "ws-1",
            stance_bias_cap: 10,
            dialogue_nudge_cap: 3,
            lens_entry_cap: 1,
            escalation_policy: {
              nudge_min_pressure: 0.4,
              nudge_min_confidence: 0.5,
              lens_min_pressure: 0.7,
              lens_min_confidence: 0.7,
              lens_requires_task_coupling: true,
              lens_requires_governance_ceiling: true
            },
            updated_at: "2026-05-18T00:00:00.000Z"
          }
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
    await waitFor(() => expect(dot.className).toContain("bg-state-warm"));
  });

  it("renders the noWorkspace banner and never fetches when workspaceId is null", async () => {
    setWorkspaceId(null);
    renderConfig();
    expect(await screen.findByTestId("config-no-workspace")).toBeTruthy();
    expect(screen.queryByText(/Soul Runtime/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads strategy config from /config/:workspaceId/strategy when workspaceId is set", async () => {
    renderConfig();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => typeof url === "string" && url.endsWith("/api/config/ws-1/strategy")
        )
      ).toBe(true);
    });
  });

  it("does not render additive config_version metadata in the generic editor", async () => {
    renderConfig();
    const strategyHeading = await screen.findByRole("heading", {
      name: /Strategy & Guardrails/i
    });
    const strategySection = strategyHeading.closest("div.mb-12") as HTMLElement;
    expect(within(strategySection).queryByText(/config version/i)).toBeNull();
  });

  it("renders manifestation budget controls from the workspace config route", async () => {
    renderConfig();
    expect(await screen.findByRole("heading", { name: /Manifestation Budget/i })).toBeTruthy();
    expect((await screen.findByLabelText(/stance bias cap/i) as HTMLInputElement).value).toBe("10");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => typeof url === "string" && url.endsWith("/api/config/ws-1/manifestation-budget")
        )
      ).toBe(true);
    });
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
    await waitFor(() => expect(dot.className).toContain("bg-state-warm"));
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
