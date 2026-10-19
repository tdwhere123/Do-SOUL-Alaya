import { once } from "node:events";
import { createServer, get } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeServer,
  type CloseableHttpServer
} from "../../../runtime/daemon/lifecycle/daemon-server-close.js";
import { defaultLifecycleTimerPort } from "../../../runtime/daemon/lifecycle/daemon-runtime-timing.js";

afterEach(() => vi.useRealTimers());

describe("HTTP server close completion", () => {
  it("waits for a real zero-arity Node HTTP close callback while a handler is active", async () => {
    let finishHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => { finishHandler = resolve; });
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    let handlerFinished = false;
    let closeEmitted = false;
    const server = createServer(async (_request, response) => {
      handlerStarted();
      await handlerGate;
      handlerFinished = true;
      response.end("finished");
    });
    server.once("close", () => { closeEmitted = true; });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing HTTP port");
    const response = new Promise<string>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}/`, { agent: false }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => { body += chunk; });
        incoming.on("end", () => resolve(body));
        incoming.on("error", reject);
      }).on("error", reject);
    });
    await started;
    let settled = false;
    const closing = closeServer(server, defaultLifecycleTimerPort).then((result) => {
      settled = true;
      return result;
    });
    try {
      expect(server.close.length).toBe(0);
      await nextTurn();
      expect(settled).toBe(false);
      expect(closeEmitted).toBe(false);
      expect(handlerFinished).toBe(false);
      finishHandler();
      expect(await response).toBe("finished");
      expect(await closing).toBe("closed");
      expect(closeEmitted).toBe(true);
      expect(handlerFinished).toBe(true);
    } finally {
      finishHandler();
      server.closeAllConnections();
      await response.catch(() => undefined);
      await closing;
    }
  });

  it("does not mistake a zero-arity callback-ignoring adapter for completion", async () => {
    vi.useFakeTimers();
    const server = { close: vi.fn(() => undefined) };
    const closing = closeServer(server, defaultLifecycleTimerPort);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await closing).toBe("timed_out");
    expect(server.close).toHaveBeenCalledWith(expect.any(Function));
  });

  it("waits for callback completion after closing idle connections", async () => {
    vi.useFakeTimers();
    let reportClosed!: () => void;
    const server: CloseableHttpServer = {
      close(callback) { reportClosed = () => callback?.(); },
      closeIdleConnections: vi.fn(() => reportClosed()),
      closeAllConnections: vi.fn()
    };
    const closing = closeServer(server, defaultLifecycleTimerPort);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await closing).toBe("closed_after_idle_connections");
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("reports callback failures instead of treating them as a successful close", async () => {
    const failure = new Error("HTTP close failed");
    const closing = closeServer({ close(callback) { callback?.(failure); } }, defaultLifecycleTimerPort);
    await expect(closing).rejects.toBe(failure);
  });

  it("reports thrown close failures", async () => {
    const failure = new Error("HTTP close threw");
    await expect(closeServer({ close() { throw failure; } }, defaultLifecycleTimerPort)).rejects.toBe(failure);
  });

  it("accepts the Node already-closed callback result", async () => {
    const server = createServer();
    expect(await closeServer(server, defaultLifecycleTimerPort)).toBe("closed");
  });

  it("reports a force-close failure without claiming completion", async () => {
    vi.useFakeTimers();
    const failure = new Error("force close failed");
    const server: CloseableHttpServer = {
      close() {},
      closeAllConnections() { throw failure; }
    };
    const closing = closeServer(server, defaultLifecycleTimerPort);
    await Promise.all([
      expect(closing).rejects.toBe(failure),
      vi.advanceTimersByTimeAsync(11_000)
    ]);
  });
});
