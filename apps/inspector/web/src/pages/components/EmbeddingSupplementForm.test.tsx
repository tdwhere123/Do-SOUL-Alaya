import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmbeddingSupplementForm from "./EmbeddingSupplementForm";
import { ToastProvider } from "../../components/Toast";
import { setInspectorToken, setWorkspaceId } from "../../api";

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

  it("submits paste mode and switches to returned file ref without displaying plaintext", async () => {
    const plaintext = "sk-test-plaintext-secret";
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
        jsonResponse({
          success: true,
          requires_daemon_restart: true,
          data: {
            provider_url: null,
            model_id: "text-embedding-3-small",
            secret_ref: "file:/tmp/alaya/secrets/openai",
            embedding_enabled: true
          }
        })
      );

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
    const [, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      secret_ref_mode: "paste",
      secret_value: plaintext
    });
    expect(JSON.parse(String((init as RequestInit).body)).secret_ref).toBeUndefined();
    await waitFor(() => expect(screen.queryByDisplayValue(plaintext)).toBeNull());
    expect(screen.getByDisplayValue("…/openai")).toBeTruthy();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
