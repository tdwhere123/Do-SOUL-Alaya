import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigSection, type SectionMeta } from "../../pages/config-section";
import { ToastProvider } from "../../components/toast";
import { setUnauthorizedHandler, setWorkspaceId } from "../../api";
import type { SectionKey } from "../../pages/config-page-state";

const SOUL: SectionMeta = { key: "soul", title: "Soul Runtime", icon: null };
const STRATEGY: SectionMeta = { key: "strategy", title: "Strategy & Guardrails", icon: null };
const SOUL_LOADED = {
  memory_consolidation_enabled: true,
  auto_checkpoint: true
} as const;

describe("ConfigSection draft lifecycle", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let payloads: Record<string, unknown>;
  let patchResult: Response | Promise<Response>;

  beforeEach(() => {
    setWorkspaceId("ws-1");
    setUnauthorizedHandler(null);
    payloads = {
      "/api/config/ws-1/soul": { ...SOUL_LOADED, config_version: "2026-06-14" },
      "/api/config/ws-1/strategy": { auto_approve_readonly: false, config_version: "2026-06-14" },
      "/api/config/ws-2/soul": { memory_consolidation_enabled: false }
    };
    patchResult = jsonResponse({ success: true });
    fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") return patchResult;
      const url = urlOf(input);
      return jsonResponse(payloads[url] ?? {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
  });

  it("resets a dirty editor when the section identity changes", async () => {
    const view = renderSection({ meta: SOUL });
    await screen.findByText(/memory_consolidation_enabled/i);
    await clickFirstPressedToggle();
    await waitFor(() => expect(screen.getByTestId("dirty-dot-soul").className).toContain("bg-state-warm"));

    view.rerender(sectionTree({ meta: STRATEGY, onDirtyChange: view.onDirtyChange, onRequiresRestart: view.onRequiresRestart }));
    expect(await screen.findByText(/auto_approve_readonly/i)).toBeTruthy();
    expect(screen.queryByText(/memory_consolidation_enabled/i)).toBeNull();
    expect(screen.getByTestId("dirty-dot-strategy").className).toContain("morandi-green");
    expect(screen.queryByTestId("dirty-dot-soul")).toBeNull();
  });

  it("loads the new workspace payload after a workspace identity change", async () => {
    const view = renderSection({ workspaceId: "ws-1" });
    await screen.findByText(/memory_consolidation_enabled/i);
    expect(screen.getAllByRole("button", { pressed: true }).length).toBeGreaterThan(0);

    view.rerender(sectionTree({
      workspaceId: "ws-2",
      onDirtyChange: view.onDirtyChange,
      onRequiresRestart: view.onRequiresRestart
    }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => urlOf(call[0]).endsWith("/api/config/ws-2/soul"))
      ).toBe(true);
    });
    expect(await screen.findByRole("button", { pressed: false })).toBeTruthy();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("keeps dirty edits when the parent rerenders the same identity", async () => {
    const view = renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await waitFor(() => expect(screen.getByTestId("dirty-dot-soul").className).toContain("bg-state-warm"));

    view.rerender(sectionTree({
      meta: SOUL,
      onDirtyChange: view.onDirtyChange,
      onRequiresRestart: view.onRequiresRestart
    }));
    expect(screen.getByRole("button", { pressed: false })).toBeTruthy();
    expect(screen.getByTestId("dirty-dot-soul").className).toContain("bg-state-warm");
    expect(screen.getByText(/memory_consolidation_enabled/i)).toBeTruthy();
  });

  it("discard restores the loaded bytes and clears dirty", async () => {
    renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /discard/i }));
    });
    await waitFor(() => expect(screen.getByTestId("dirty-dot-soul").className).toContain("morandi-green"));
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2);
    expect(namedButton(/discard/i).disabled).toBe(true);
    expect(namedButton(/commit changes/i).disabled).toBe(true);
  });

  it("saves the current JSON bytes, keeps them after success, and does not request a restart", async () => {
    const view = renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /commit changes/i }));
    });
    const patch = await waitForPatch(fetchMock);
    expect(patch.url).toBe("/api/config/ws-1/soul");
    expect(patch.body).toBe(JSON.stringify({
      memory_consolidation_enabled: false,
      auto_checkpoint: true
    }));
    expect(JSON.parse(patch.body)).not.toHaveProperty("config_version");
    expect(await screen.findByText("Soul Runtime saved")).toBeTruthy();
    expect(view.onRequiresRestart).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("dirty-dot-soul").className).toContain("morandi-green"));
    expect(screen.getByRole("button", { pressed: false })).toBeTruthy();
    expect(namedButton(/commit changes/i).disabled).toBe(true);
  });

  it("shows the restart toast and notifies the page after a restart-required save", async () => {
    patchResult = jsonResponse({ success: true, requires_daemon_restart: true });
    const view = renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /commit changes/i }));
    });
    expect(await screen.findByText("Soul Runtime patched · daemon restart pending")).toBeTruthy();
    expect(view.onRequiresRestart).toHaveBeenCalledTimes(1);
  });

  it("keeps edits made while a save is pending against the captured save baseline", async () => {
    const pending = deferred<Response>();
    patchResult = pending.promise;
    renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /commit changes/i }));
    });
    await screen.findByRole("button", { name: /saving/i });
    expect(namedButton(/saving/i).disabled).toBe(true);
    expect(namedButton(/discard/i).disabled).toBe(true);
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { pressed: true }));
    });
    const patch = await waitForPatch(fetchMock);
    expect(JSON.parse(patch.body)).toEqual({
      memory_consolidation_enabled: false,
      auto_checkpoint: true
    });
    await act(async () => {
      pending.resolve(jsonResponse({ success: true }));
      await pending.promise;
    });
    await waitFor(() => expect(namedButton(/commit changes/i).disabled).toBe(false));
    expect(screen.getByTestId("dirty-dot-soul").className).toContain("bg-state-warm");
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(2);
  });

  it("does not let an older save rewrite a newly loaded section", async () => {
    const pending = deferred<Response>();
    patchResult = pending.promise;
    const view = renderSection({ meta: SOUL });
    await screen.findByText(/memory_consolidation_enabled/i);
    await clickFirstPressedToggle();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /commit changes/i }));
    });
    await waitForPatch(fetchMock);

    view.rerender(sectionTree({
      meta: STRATEGY,
      onDirtyChange: view.onDirtyChange,
      onRequiresRestart: view.onRequiresRestart
    }));
    expect(await screen.findByText(/auto_approve_readonly/i)).toBeTruthy();
    expect(screen.getByTestId("dirty-dot-strategy").className).toContain("morandi-green");

    await act(async () => {
      pending.resolve(jsonResponse({ success: true, requires_daemon_restart: true }));
      await pending.promise;
    });
    await waitFor(() => expect(screen.getByTestId("dirty-dot-strategy").className).toContain("morandi-green"));
    expect(screen.queryByText(/memory_consolidation_enabled/i)).toBeNull();
    expect(screen.getByText(/auto_approve_readonly/i)).toBeTruthy();
    expect(screen.getByRole("button", { pressed: false })).toBeTruthy();
    expect(patchCount(fetchMock)).toBe(1);
    expect(view.onRequiresRestart).toHaveBeenCalledTimes(1);
  });

  it("toasts a non-401 save failure, leaves the draft dirty, and does not restart", async () => {
    patchResult = jsonResponse({ message: "disk full" }, 500);
    const view = renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /commit changes/i }));
    });
    expect(await screen.findByText("Failed to save Soul Runtime: disk full")).toBeTruthy();
    expect(view.onRequiresRestart).not.toHaveBeenCalled();
    expect(screen.getByTestId("dirty-dot-soul").className).toContain("bg-state-warm");
    expect(screen.getByRole("button", { pressed: false })).toBeTruthy();
    expect(namedButton(/commit changes/i).disabled).toBe(false);
  });

  it("does not toast a 401 save failure and still leaves the draft dirty", async () => {
    patchResult = jsonResponse({}, 401);
    const view = renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: /commit changes/i }));
    });
    await waitFor(() => expect(namedButton(/commit changes/i).disabled).toBe(false));
    expect(screen.queryByText(/Failed to save Soul Runtime/i)).toBeNull();
    expect(view.onRequiresRestart).not.toHaveBeenCalled();
    expect(screen.getByTestId("dirty-dot-soul").className).toContain("bg-state-warm");
  });

  it("does not render commit controls for a read-only section", async () => {
    renderSection({ meta: { ...STRATEGY, readOnly: true } });
    expect(await screen.findByText(/auto_approve_readonly/i)).toBeTruthy();
    expect(screen.getByText("false")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /commit changes/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(screen.queryByRole("button", { pressed: false })).toBeNull();
  });

  it("omits hidden config_version from the editor", async () => {
    renderSection({ meta: SOUL });
    await screen.findByText(/auto_checkpoint/i);
    expect(screen.queryByText(/config_version/i)).toBeNull();
    expect(screen.queryByText("2026-06-14")).toBeNull();
  });

  it("reports dirty on edit and clears the section on unmount", async () => {
    const onDirtyChange = vi.fn<(key: SectionKey, dirty: boolean) => void>();
    const view = renderSection({ meta: SOUL, onDirtyChange });
    await screen.findByText(/auto_checkpoint/i);
    await clickFirstPressedToggle();
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith("soul", true));
    onDirtyChange.mockClear();
    view.unmount();
    expect(onDirtyChange).toHaveBeenCalledWith("soul", false);
    expect(onDirtyChange).not.toHaveBeenCalledWith("soul", true);
  });
});

function renderSection(options: {
  readonly meta?: SectionMeta;
  readonly workspaceId?: string;
  readonly onDirtyChange?: (key: SectionKey, dirty: boolean) => void;
  readonly onRequiresRestart?: () => void;
}) {
  const onDirtyChange = options.onDirtyChange ?? vi.fn();
  const onRequiresRestart = options.onRequiresRestart ?? vi.fn();
  const view = render(sectionTree({
    meta: options.meta ?? SOUL,
    workspaceId: options.workspaceId ?? "ws-1",
    onDirtyChange,
    onRequiresRestart
  }));
  return { ...view, onDirtyChange, onRequiresRestart };
}

function sectionTree(options: {
  readonly meta?: SectionMeta;
  readonly workspaceId?: string;
  readonly onDirtyChange: (key: SectionKey, dirty: boolean) => void;
  readonly onRequiresRestart: () => void;
}) {
  return (
    <ToastProvider>
      <ConfigSection
        meta={options.meta ?? SOUL}
        workspaceId={options.workspaceId ?? "ws-1"}
        onDirtyChange={options.onDirtyChange}
        onRequiresRestart={options.onRequiresRestart}
      />
    </ToastProvider>
  );
}

function namedButton(name: RegExp): HTMLButtonElement {
  const button = screen.getByRole("button", { name });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected a button");
  }
  return button;
}

async function clickFirstPressedToggle(): Promise<void> {
  await waitFor(() => {
    expect(screen.getAllByRole("button", { pressed: true }).length).toBeGreaterThan(0);
  });
  const toggles = screen.getAllByRole("button", { pressed: true });
  await act(async () => {
    await userEvent.click(toggles[0]);
  });
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  throw new Error("unsupported fetch input");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForPatch(fetchMock: ReturnType<typeof vi.fn>): Promise<{ url: string; body: string }> {
  return waitFor(() => readPatch(fetchMock));
}

function patchCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH").length;
}

function readPatch(fetchMock: ReturnType<typeof vi.fn>): { url: string; body: string } {
  for (const [input, init] of fetchMock.mock.calls) {
    if (init?.method !== "PATCH") continue;
    if (typeof init.body !== "string") {
      throw new Error("expected JSON PATCH body");
    }
    return { url: urlOf(input), body: init.body };
  }
  throw new Error("expected PATCH");
}
