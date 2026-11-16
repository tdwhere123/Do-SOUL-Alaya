/// <reference types="node" />
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiFetchWithHeaders, setUnauthorizedHandler, setWorkspaceId } from "../../api/api";

describe("Inspector request retry decisions", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    setWorkspaceId(null);
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe.each(["GET", "HEAD"])("%s", (method) => {
    it.each(["response", "network"])("waits 200ms before retrying a transient %s failure", async (kind) => {
      if (kind === "response") {
        fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
      } else {
        fetchMock.mockRejectedValueOnce(new TypeError("connection lost"));
      }
      fetchMock.mockResolvedValueOnce(new Response('{"ok":true}'));
      const request = apiFetch("/status", { method });
      await vi.advanceTimersByTimeAsync(199);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it.each([null, undefined, { reason: "last failure" }])("preserves the final rejection identity (%j)", async (reason) => {
    fetchMock.mockRejectedValueOnce(new TypeError("first failure")).mockRejectedValueOnce(reason);
    const rejected = expect(apiFetch("/status")).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["POST", "PATCH", "DELETE"])("does not retry a %s network failure", async (method) => {
    const error = new TypeError("connection lost");
    fetchMock.mockRejectedValue(error);
    await expect(apiFetch("/status", { method })).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry an aborted signal with a non-Error rejection", async () => {
    const controller = new AbortController();
    const reason = { reason: "caller cancelled" };
    controller.abort(reason);
    fetchMock.mockRejectedValue(reason);
    await expect(apiFetch("/status", { signal: controller.signal })).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reclassify a network failure when the caller aborts in the next microtask", async () => {
    const controller = new AbortController();
    const reason = { reason: "cancelled after rejection" };
    fetchMock.mockRejectedValueOnce(new TypeError("connection lost")).mockRejectedValueOnce(reason);
    let settled = false;
    const observed = apiFetch("/status", { signal: controller.signal }).catch(error => {
      settled = true;
      return error;
    });
    void Promise.resolve().then(() => controller.abort(reason));
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await observed).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Inspector API over loopback HTTP", () => {
  let server: Server | undefined;
  let methods: Array<string | undefined>;

  beforeEach(() => {
    methods = [];
    setWorkspaceId(null);
    setUnauthorizedHandler(null);
  });

  afterEach(async () => {
    setUnauthorizedHandler(null);
    if (server !== undefined) {
      const activeServer = server;
      server = undefined;
      const closing = new Promise<void>((resolve, reject) => {
        activeServer.close((error) => error ? reject(error) : resolve());
      });
      activeServer.closeAllConnections();
      await closing;
    }
  });

  async function listen(handler: RequestListener): Promise<string> {
    server = createServer((request, response) => {
      methods.push(request.method);
      handler(request, response);
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected loopback TCP listener");
    return `http://127.0.0.1:${address.port}/status`;
  }

  it("retries a 503 once and returns the successful payload and response headers", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(methods.length === 1 ? 503 : 200, { "x-page-cursor": "next-page" });
      response.end('{"ok":true}');
    });
    const result = await apiFetchWithHeaders<{ ok: boolean }>(url);
    expect(result.payload).toEqual({ ok: true });
    expect(result.headers.get("x-page-cursor")).toBe("next-page");
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("does not replay a mutation after a 503", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(503);
      response.end('{"error":"temporarily unavailable"}');
    });
    await expect(apiFetch(url, { method: "POST", body: { requested: true } })).rejects.toMatchObject({
      status: 503, message: "temporarily unavailable"
    });
    expect(methods).toEqual(["POST"]);
  });

  it("recovers once from a connection closed before response headers", async () => {
    const url = await listen((request, response) => {
      if (methods.length === 1) request.socket.destroy();
      else response.end('{"ok":true}');
    });
    await expect(apiFetch(url)).resolves.toEqual({ ok: true });
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("does not reinterpret an invalid successful JSON body as a transport failure", async () => {
    const url = await listen((_request, response) => response.end("not-json"));
    await expect(apiFetch(url)).rejects.toMatchObject({ name: "SyntaxError" });
    expect(methods).toEqual(["GET"]);
  });

  it("invokes unauthorized handling once when a retry receives 401", async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const url = await listen((_request, response) => {
      response.writeHead(methods.length === 1 ? 503 : 401);
      response.end("{}");
    });
    await expect(apiFetch(url)).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledOnce();
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("does not retry a caller cancellation while waiting for response headers", async () => {
    const url = await listen(() => {});
    if (server === undefined) throw new Error("Expected listening server");
    const received = once(server, "request");
    const controller = new AbortController();
    const rejected = expect(apiFetch(url, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await received;
    controller.abort();
    await rejected;
    expect(methods).toEqual(["GET"]);
  });
});
