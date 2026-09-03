import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_ONNX_EMBEDDING_DIMENSIONS,
  LocalOnnxEmbeddingClient
} from "../../embedding-recall/local-onnx-embedding-client.js";
import {
  LocalOnnxEmbeddingChildExitedError,
  createForkLocalOnnxEmbeddingHost,
  type LocalOnnxEmbeddingIpcHost
} from "../../embedding-recall/local-onnx-process/ipc-client.js";

const stubChildPath = fileURLToPath(
  new URL("./local-onnx-embedding-ipc-stub-child.mjs", import.meta.url)
);

describe("LocalOnnxEmbeddingClient IPC isolation", () => {
  const clients: LocalOnnxEmbeddingClient[] = [];

  afterEach(async () => {
    const pending = clients.splice(0);
    await Promise.all(pending.map((client) => client.close()));
  });

  it("returns vectors from the child without loading a pipeline in the parent", async () => {
    const client = openClient();
    const vectors = await client.embedTexts(["ok"], { timeoutMs: 5_000 });
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.length).toBe(LOCAL_ONNX_EMBEDDING_DIMENSIONS);
    expect(parentMapsOnnxRuntime()).toBe(false);
  });

  it("reaps the isolated child on close", async () => {
    const tracking = liveChildHost();
    const client = openClient(tracking.host);
    await client.warmup();
    expect(tracking.live).toBe(1);
    await client.close();
    expect(tracking.live).toBe(0);
  });

  it("reaps a child that races with close", async () => {
    const tracking = liveChildHost();
    const client = openClient(tracking.host);
    const warmup = client.warmup();
    await client.close();
    await warmup.catch(() => undefined);
    expect(tracking.live).toBe(0);
  });

  it("does not charge isolate load against the embed timeout", async () => {
    const inner = createForkLocalOnnxEmbeddingHost(stubChildPath);
    const host: LocalOnnxEmbeddingIpcHost = {
      spawn() {
        const child = inner.spawn();
        return new Proxy(child, {
          get(target, property, receiver) {
            if (property === "send") {
              return (message: unknown, callback?: (error: Error | null) => void) => {
                const op = (message as { readonly op?: unknown }).op;
                if (op === "warmup") {
                  setTimeout(() => target.send(message, callback), 80);
                  return true;
                }
                return target.send(message, callback);
              };
            }
            return Reflect.get(target, property, receiver);
          }
        });
      }
    };
    const client = openClient(host);
    await expect(client.embedTexts(["ok"], { timeoutMs: 40 })).resolves.toHaveLength(1);
  });

  it("keeps the isolated child referenced while an IPC request is pending", async () => {
    const tracking = trackingHost();
    const client = openClient(tracking.host);

    await expect(client.embedTexts(["ok"], { timeoutMs: 5_000 })).resolves.toHaveLength(1);

    expect(tracking.processRefs).toBeGreaterThan(0);
    expect(tracking.channelRefs).toBeGreaterThan(0);
    expect(tracking.processUnrefs).toBeGreaterThan(tracking.processRefs);
    expect(tracking.channelUnrefs).toBeGreaterThan(tracking.channelRefs);
  });

  it("fail-closes when the child exits mid-request", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__crash__"], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LocalOnnxEmbeddingChildExitedError
    );
    await expect(client.embedTexts(["ok"], { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LocalOnnxEmbeddingChildExitedError
    );
  });

  it("fail-closes when the child never replies", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__hang__"], { timeoutMs: 40 })).rejects.toThrow(/timed out/);
  });

  it("recycles a timed-out child before serving the next request", async () => {
    const tracking = liveChildHost();
    const client = openClient(tracking.host);
    await expect(client.embedTexts(["__hang__"], { timeoutMs: 40 })).rejects.toThrow(/timed out/);
    const vectors = await client.embedTexts(["ok"], { timeoutMs: 5_000 });
    expect(vectors).toHaveLength(1);
    expect(tracking.live).toBe(1);
    await client.close();
    expect(tracking.live).toBe(0);
  });

  it("does not kill an isolate while an older request is still in flight", async () => {
    const tracking = liveChildHost();
    const client = openClient(tracking.host);
    const older = client.embedTexts(["__hang__"], { timeoutMs: 250 });
    const later = client.embedTexts(["__hang__"], { timeoutMs: 40 });
    await expect(later).rejects.toThrow(/timed out/);
    expect(tracking.live).toBe(1);
    await expect(older).rejects.toThrow(/timed out/);
    await expect(client.embedTexts(["ok"], { timeoutMs: 5_000 })).resolves.toHaveLength(1);
    expect(tracking.live).toBe(1);
  });

  it("waits for the send callback when IPC reports backpressure", async () => {
    const client = openClient(backpressuredHost());
    await expect(client.embedTexts(["ok"], { timeoutMs: 5_000 })).resolves.toHaveLength(1);
  });

  it("fail-closes when the child returns no vectors", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__empty__"], { timeoutMs: 5_000 })).rejects.toThrow(
      /0 vectors for 1 inputs/
    );
  });

  it("fail-closes when the child returns an empty row", async () => {
    const client = openClient();
    await expect(client.embedTexts(["__empty_row__"], { timeoutMs: 5_000 })).rejects.toThrow(
      /row 0 was empty/
    );
  });

  function liveChildHost(): { host: LocalOnnxEmbeddingIpcHost; live: number } {
    const inner = createForkLocalOnnxEmbeddingHost(stubChildPath);
    const tracking: { host: LocalOnnxEmbeddingIpcHost; live: number } = {
      live: 0,
      host: {
        spawn() {
          tracking.live += 1;
          const child = inner.spawn();
          child.on("exit", () => {
            tracking.live -= 1;
          });
          return child;
        }
      }
    };
    return tracking;
  }

  function openClient(host?: LocalOnnxEmbeddingIpcHost): LocalOnnxEmbeddingClient {
    const client = new LocalOnnxEmbeddingClient({
      ipcHost: host ?? createForkLocalOnnxEmbeddingHost(stubChildPath)
    });
    clients.push(client);
    return client;
  }

  function backpressuredHost(): LocalOnnxEmbeddingIpcHost {
    const inner = createForkLocalOnnxEmbeddingHost(stubChildPath);
    return {
      spawn() {
        const child = inner.spawn();
        return new Proxy(child, {
          get(target, property, receiver) {
            if (property === "send") {
              return (message: unknown, callback?: (error: Error | null) => void) => {
                target.send(message, callback);
                return false;
              };
            }
            return Reflect.get(target, property, receiver);
          }
        });
      }
    };
  }

  function trackingHost(): TrackingHost {
    const inner = createForkLocalOnnxEmbeddingHost(stubChildPath);
    const counts = {
      processRefs: 0,
      processUnrefs: 0,
      channelRefs: 0,
      channelUnrefs: 0
    };
    return {
      host: {
        spawn() {
          const child = inner.spawn();
          const channel = (child as { channel?: { ref?(): void; unref?(): void } }).channel;
          return new Proxy(child, {
            get(target, property, receiver) {
              if (property === "ref") return () => {
                counts.processRefs += 1;
                (target as { ref?(): void }).ref?.();
              };
              if (property === "unref") return () => {
                counts.processUnrefs += 1;
                target.unref?.();
              };
              if (property === "channel" && channel !== undefined) {
                return {
                  ref: () => {
                    counts.channelRefs += 1;
                    channel.ref?.();
                  },
                  unref: () => {
                    counts.channelUnrefs += 1;
                    channel.unref?.();
                  }
                };
              }
              return Reflect.get(target, property, receiver);
            }
          });
        }
      },
      get processRefs() { return counts.processRefs; },
      get processUnrefs() { return counts.processUnrefs; },
      get channelRefs() { return counts.channelRefs; },
      get channelUnrefs() { return counts.channelUnrefs; }
    };
  }
});

interface TrackingHost {
  readonly host: LocalOnnxEmbeddingIpcHost;
  readonly processRefs: number;
  readonly processUnrefs: number;
  readonly channelRefs: number;
  readonly channelUnrefs: number;
}

function parentMapsOnnxRuntime(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const maps = readProcSelfMaps();
    return /onnxruntime/i.test(maps);
  } catch {
    return false;
  }
}

function readProcSelfMaps(): string {
  return readFileSync("/proc/self/maps", "utf8");
}
