import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  setInspectorToken,
  setUnauthorizedHandler,
  setWorkspaceId,
  type ApiError
} from "./api";

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
});
