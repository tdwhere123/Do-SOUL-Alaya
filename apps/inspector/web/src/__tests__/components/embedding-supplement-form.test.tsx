import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import EmbeddingSupplementForm from "../../components/embedding-supplement-form";
import { ToastProvider } from "../../components/toast";
import { setInspectorToken, setWorkspaceId } from "../../api";

function renderForm() {
  return render(
    <ToastProvider>
      <EmbeddingSupplementForm workspaceId="ws-1" />
    </ToastProvider>
  );
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

  it("renders configured embedding values read-only", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        provider_url: "https://api.openai.com/v1",
        model_id: "text-embedding-3-small",
        secret_ref: "env:OPENAI_API_KEY",
        embedding_enabled: true
      })
    );
    renderForm();

    expect(await screen.findByText("https://api.openai.com/v1")).toBeTruthy();
    expect(screen.getByText("text-embedding-3-small")).toBeTruthy();
    expect(screen.getByText("env:OPENAI_API_KEY")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /commit/i })).toBeNull();
  });

  it("masks file secret paths and points configuration at the CLI", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        provider_url: null,
        model_id: null,
        secret_ref: "file:/etc/alaya/secrets/openai",
        embedding_enabled: false
      })
    );
    renderForm();

    expect(await screen.findByText("file:…/openai")).toBeTruthy();
    expect(screen.getByText(/Inspector never edits provider secrets/i)).toBeTruthy();
    expect(screen.getByText(/alaya install --non-interactive/)).toBeTruthy();
  });

  it("surfaces a toast when the initial GET fails with a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    renderForm();

    await waitFor(() =>
      expect(screen.getByText(/Failed to load embedding config: network down/i)).toBeTruthy()
    );
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("surfaces a degraded embedding banner with humanised hint", async () => {
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
    expect(screen.getByText(/Provider rejected our request/i)).toBeTruthy();
    expect(screen.getByText(/checked 2026-05-07T00:00:00\.000Z/i)).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
