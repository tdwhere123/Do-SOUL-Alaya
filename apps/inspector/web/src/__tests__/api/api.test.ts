import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  setInspectorToken,
  setUnauthorizedHandler,
  setWorkspaceId,
  type ApiError
} from "../../api/api";

describe("apiFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setInspectorToken("test-token");
    setWorkspaceId("ws-1");
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects X-Alaya-Inspector-Token header on every request", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await apiFetch("/status");
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      "X-Alaya-Inspector-Token": "test-token"
    });
  });

  it("interpolates :workspaceId placeholder", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 200 })
    );
    await apiFetch("/config/:workspaceId/soul");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/config/ws-1/soul");
  });

  it("invokes the global unauthorized handler and throws ApiError on 401", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(apiFetch("/status")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("retries GET on 5xx exactly once", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
    const result = await apiFetch<{ ok: boolean }>("/status");
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry PATCH on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(
      apiFetch("/config/:workspaceId/soul", { method: "PATCH", body: { x: 1 } })
    ).rejects.toMatchObject({ status: 503 } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces backend error strings instead of a generic HTTP label", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "workspace_forbidden" }), { status: 403 })
    );

    await expect(apiFetch("/graph/ws-other")).rejects.toMatchObject({
      message: "workspace_forbidden",
      status: 403
    });
  });

  it("surfaces structured backend error messages", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "request token missing" } }),
        { status: 403 }
      )
    );

    await expect(apiFetch("/graph/ws1")).rejects.toMatchObject({
      message: "request token missing",
      status: 403
    });
  });

  it("unwraps success envelopes for GET config routes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { enabled: true } }), { status: 200 })
    );

    await expect(apiFetch<{ enabled: boolean }>("/config/:workspaceId/soul")).resolves.toEqual({
      enabled: true
    });
  });

  it("throws a friendly schema error instead of surfacing raw ZodError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: "not-an-object" }), { status: 200 })
    );

    const rejection = apiFetch("/config/:workspaceId/soul");
    await expect(rejection).rejects.toMatchObject({
      message: "Invalid API response shape",
      status: 502
    });
    await expect(rejection).rejects.toSatisfy(
      (error: unknown) => !(error instanceof Error && error.name === "ZodError")
    );
  });
});
