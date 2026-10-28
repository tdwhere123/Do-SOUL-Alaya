import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ManifestationBudgetConfigSchema } from "@do-soul/alaya-protocol";
import ConfigPage from "../../pages/config";
import { ConfigSection, type SectionMeta } from "../../pages/config-section";
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

function renderConfigSection(meta: SectionMeta) {
  return render(
    <ToastProvider>
      <ConfigSection
        meta={meta}
        workspaceId="ws-1"
        onDirtyChange={vi.fn()}
        onRequiresRestart={vi.fn()}
      />
    </ToastProvider>
  );
}

describe("ConfigPage", () => {
  it("persists an initial section load failure without a synced indicator", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderConfigSection({ key: "soul", title: "SOUL", icon: null });
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.queryByTestId("dirty-dot-soul")).toBeNull();
  });
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
      if (url.endsWith("/embedding-status/ws-1")) {
        return jsonResponse({ success: true, data: { workspace_id: "ws-1", embedding_enabled: false,
          provider_configured: false, model_id: null, storage_available: true, effective_mode: "keyword_only",
          degraded_reason: null, checked_at: "2026-10-28T00:00:00.000Z" } });
      }
      if (url.endsWith("/config/ws-1/garden-compute")) {
        return jsonResponse({
          provider_kind: "local_heuristics",
          provider_url: null,
          model_id: null,
          secret_ref: null,
          enabled: false
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
            updated_at: "2026-05-18T00:00:00.000Z",
            source: "stored"
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

  it("patches only editable manifestation budget fields, not read metadata", async () => {
    renderConfig();
    const stanceCap = await screen.findByLabelText(/stance bias cap/i) as HTMLInputElement;
    await act(async () => {
      await userEvent.clear(stanceCap);
      await userEvent.type(stanceCap, "12");
    });
    const budgetHeading = screen.getByRole("heading", { name: /Manifestation Budget/i });
    const budgetSection = budgetHeading.closest("div.mb-12") as HTMLElement;
    await act(async () => {
      await userEvent.click(within(budgetSection).getByRole("button", { name: /commit budget/i }));
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
    });
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body.source).toBeUndefined();
    expect(body.stance_bias_cap).toBe(12);
    expect(ManifestationBudgetConfigSchema.unwrap().partial().strict().safeParse(body).success).toBe(true);
  });

  it("renders runtime provider panels read-only with the CLI configuration path", async () => {
    renderConfig();
    const embeddingHeading = await screen.findByRole("heading", { name: /Embedding Supplement/i });
    const embeddingPanel = embeddingHeading.closest("div.mb-12") as HTMLElement;
    expect(within(embeddingPanel).getByRole("note").textContent).toMatch(/read-only/i);
    expect(within(embeddingPanel).queryAllByRole("button")).toHaveLength(0);
    expect(within(embeddingPanel).queryAllByRole("textbox")).toHaveLength(0);

    const gardenHeading = await screen.findByRole("heading", { name: /Garden Compute/i });
    const gardenPanel = gardenHeading.closest("div.mb-12") as HTMLElement;
    expect(within(gardenPanel).getByText(/alaya install --non-interactive/i)).toBeTruthy();
    expect(within(gardenPanel).queryAllByRole("button")).toHaveLength(0);
    expect(within(gardenPanel).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("labels strategy flags as stored-only without an enforcement consumer", async () => {
    renderConfig();
    const strategyHeading = await screen.findByRole("heading", { name: /Strategy & Guardrails/i });
    const strategySection = strategyHeading.closest("div.mb-12") as HTMLElement;
    const notice = within(strategySection).getByRole("note");
    expect(notice.textContent).toMatch(/stored values only/i);
    expect(notice.textContent).toMatch(/does not change agent policy/i);
    expect(within(strategySection).queryAllByRole("button")).toHaveLength(0);
    expect(within(strategySection).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shows restart banner after PATCH that returns requires_daemon_restart", async () => {
    renderConfig();
    const dot = await screen.findByTestId("dirty-dot-soul");
    await waitFor(() => screen.getByText(/auto_checkpoint/i));
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

  it("does not let an older save response dirty a newly loaded section", async () => {
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return patchResponse;
      if (url.endsWith("/config/ws-1/soul")) {
        return jsonResponse({ memory_consolidation_enabled: true });
      }
      if (url.endsWith("/config/ws-1/strategy")) {
        return jsonResponse({ auto_approve_readonly: false });
      }
      return jsonResponse({});
    });

    const view = renderConfigSection({ key: "soul", title: "Soul Runtime", icon: null });
    const soulToggle = await screen.findByRole("button", { pressed: true });
    await userEvent.click(soulToggle);
    await userEvent.click(screen.getByRole("button", { name: /commit changes/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true)
    );

    view.rerender(
      <ToastProvider>
        <ConfigSection
          meta={{ key: "strategy", title: "Strategy & Guardrails", icon: null }}
          workspaceId="ws-1"
          onDirtyChange={vi.fn()}
          onRequiresRestart={vi.fn()}
        />
      </ToastProvider>
    );
    const strategyDot = await screen.findByTestId("dirty-dot-strategy");
    await waitFor(() => expect(strategyDot.className).toContain("morandi-green"));

    await act(async () => {
      resolvePatch(jsonResponse({ success: true }));
      await patchResponse;
    });
    await waitFor(() => expect(strategyDot.className).toContain("morandi-green"));
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
