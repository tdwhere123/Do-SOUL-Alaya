import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmbeddingSupplementForm from "./EmbeddingSupplementForm";
import { ToastProvider } from "./Toast";
import { setInspectorToken, setWorkspaceId } from "../api";

function renderForm() {
  const onRestart = vi.fn();
  const utils = render(
    <ToastProvider>
      <EmbeddingSupplementForm onRequiresRestart={onRestart} />
    </ToastProvider>
  );
  return { ...utils, onRestart };
}

describe("EmbeddingSupplementForm", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders env: secret value as plaintext (env vars are not secret)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        provider_url: "https://api.openai.com/v1",
        model_id: "text-embedding-3-small",
        secret_ref: "env:OPENAI_API_KEY",
        embedding_enabled: true
      })
    );
    renderForm();
    await waitFor(() => screen.getByDisplayValue("OPENAI_API_KEY"));
  });

  it("masks file: paths until eye toggle is pressed", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        provider_url: null,
        model_id: null,
        secret_ref: "file:/etc/alaya/secrets/openai",
        embedding_enabled: false
      })
    );
    renderForm();
    await waitFor(() => screen.getByDisplayValue("…/openai"));
    const eye = screen.getByRole("button", { name: /show full path/i });
    await act(async () => {
      await userEvent.click(eye);
    });
    expect(screen.getByDisplayValue("/etc/alaya/secrets/openai")).toBeTruthy();
  });

  it("renders env, file, and paste chips together and selects the current ref mode", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        provider_url: null,
        model_id: null,
        secret_ref: "file:/etc/alaya/secrets/openai",
        embedding_enabled: false
      })
    );
    renderForm();

    await waitFor(() => screen.getByRole("button", { name: "env:" }));
    expect(screen.getByRole("button", { name: "file:" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "paste:" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "file:" }).className).toContain("bg-ink-600");
    expect(screen.getByDisplayValue("…/openai")).toBeTruthy();
  });

  it("rejects env: name not in UPPER_SNAKE_CASE on blur", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        provider_url: null,
        model_id: null,
        secret_ref: null,
        embedding_enabled: false
      })
    );
    renderForm();
    await waitFor(() => screen.getByPlaceholderText("OPENAI_API_KEY"));
    const input = screen.getByPlaceholderText("OPENAI_API_KEY");
    await act(async () => {
      await userEvent.type(input, "lowercase-bad");
      input.blur();
    });
    await waitFor(() =>
      expect(screen.getByText(/UPPER_SNAKE_CASE/i)).toBeTruthy()
    );
  });

  it("surfaces a toast when the initial GET fails with a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    renderForm();

    await waitFor(() =>
      expect(screen.getByText(/Failed to load embedding config: network down/i)).toBeTruthy()
    );
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("surfaces a toast when the patch returns 500", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          provider_url: null,
          model_id: null,
          secret_ref: null,
          embedding_enabled: false
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: "internal server error" }, 500)
      );

    const { onRestart } = renderForm();
    await waitFor(() => screen.getByPlaceholderText("OPENAI_API_KEY"));

    await act(async () => {
      await userEvent.type(
        screen.getByPlaceholderText("OPENAI_API_KEY"),
        "OPENAI_API_KEY"
      );
      await userEvent.click(
        screen.getByRole("button", { name: /commit embedding/i })
      );
    });

    await waitFor(() =>
      expect(screen.getByText(/Failed to patch embedding/i)).toBeTruthy()
    );
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("ignores a second click on the commit button while a save is already in flight", async () => {
    let resolvePatch: (response: Response) => void = () => undefined;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "PATCH") return pendingPatch;
      if (u.includes("/embedding-status/")) {
        return jsonResponse(degradedNullEmbeddingStatus());
      }
      // GET config
      return jsonResponse({
        provider_url: null,
        model_id: null,
        secret_ref: null,
        embedding_enabled: false
      });
    });

    const { onRestart } = renderForm();
    await waitFor(() => screen.getByPlaceholderText("OPENAI_API_KEY"));

    const commitButton = screen.getByRole("button", { name: /commit embedding/i });
    await act(async () => {
      await userEvent.type(
        screen.getByPlaceholderText("OPENAI_API_KEY"),
        "OPENAI_API_KEY"
      );
    });

    await act(async () => {
      await userEvent.click(commitButton);
    });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await userEvent.click(commitButton);
    });

    await act(async () => {
      resolvePatch(
        jsonResponse({
          success: true,
          requires_daemon_restart: true,
          data: {
            provider_url: null,
            model_id: null,
            secret_ref: "env:OPENAI_API_KEY",
            embedding_enabled: false
          }
        })
      );
    });

    await waitFor(() => expect(onRestart).toHaveBeenCalledOnce());
    const patchCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patchCalls).toHaveLength(1);
  });

  it("submits paste mode and switches to returned file ref without displaying plaintext", async () => {
    const plaintext = "sk-test-plaintext-secret";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "PATCH") {
        return jsonResponse({
          success: true,
          requires_daemon_restart: true,
          data: {
            provider_url: null,
            model_id: "text-embedding-3-small",
            secret_ref: "file:/tmp/alaya/secrets/openai",
            embedding_enabled: true
          }
        });
      }
      if (u.includes("/embedding-status/")) {
        return jsonResponse(degradedNullEmbeddingStatus());
      }
      // GET config
      return jsonResponse({
        provider_url: null,
        model_id: null,
        secret_ref: null,
        embedding_enabled: false
      });
    });

    const { onRestart } = renderForm();
    await waitFor(() => screen.getByRole("button", { name: "paste:" }));

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "paste:" }));
    });
    await waitFor(() => screen.getByPlaceholderText("paste API key"));
    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText("paste API key"), plaintext);
      await userEvent.click(screen.getByRole("button", { name: /commit embedding/i }));
    });

    await waitFor(() => expect(onRestart).toHaveBeenCalledOnce());
    // U2: form fetches /embedding-status on mount and after save, so the
    // PATCH is no longer the second fetch by index. Match by method.
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patchCall).toBeTruthy();
    const init = patchCall![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      secret_ref_mode: "paste",
      secret_value: plaintext
    });
    expect(JSON.parse(String(init.body)).secret_ref).toBeUndefined();
    await waitFor(() => expect(screen.queryByDisplayValue(plaintext)).toBeNull());
    expect(screen.getByDisplayValue("…/openai")).toBeTruthy();
  });
  it("surfaces a degraded embedding banner with humanised hint (U2)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          provider_url: "https://api.example.test/v1",
          model_id: "text-embedding-3-small",
          secret_ref: "env:OPENAI_API_KEY",
          embedding_enabled: true
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            workspace_id: "ws-1",
            embedding_enabled: true,
            provider_configured: true,
            model_id: "text-embedding-3-small",
            storage_available: true,
            effective_mode: "degraded",
            degraded_reason: "provider_unavailable",
            checked_at: "2026-05-07T00:00:00.000Z"
          }
        })
      );

    renderForm();
    await waitFor(() => screen.getByText(/Embedding Degraded/i));
    expect(
      screen.getByText(/Provider rejected our request/i)
    ).toBeTruthy();
    expect(screen.getByText(/checked 2026-05-07T00:00:00\.000Z/i)).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// Default healthy embedding-status payload used to keep the U2 status
// poll from interfering with tests focused on PATCH behavior. The
// "Degraded" state has its own dedicated test below.
function degradedNullEmbeddingStatus() {
  return {
    success: true,
    data: {
      workspace_id: "ws-1",
      embedding_enabled: false,
      provider_configured: false,
      model_id: "text-embedding-3-small",
      storage_available: true,
      effective_mode: "keyword_only",
      degraded_reason: null,
      checked_at: "2026-05-07T00:00:00.000Z"
    }
  };
}
