import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_ONNX_EMBEDDING_DIMENSIONS,
  LocalOnnxEmbeddingClient
} from "../../embedding-recall/local-onnx-embedding-client.js";
import {
  LocalOnnxEmbeddingChildExitedError,
  createForkLocalOnnxEmbeddingHost,
  LocalOnnxEmbeddingIpcSession,
  type LocalOnnxEmbeddingIpcHost,
  type LocalOnnxEmbeddingIpcProcess
} from "../../embedding-recall/local-onnx-process/ipc-client.js";

const stubChildPath = fileURLToPath(
  new URL("./local-onnx-embedding-ipc-stub-child.mjs", import.meta.url)
);
const loadingChildPath = fileURLToPath(
  new URL("./local-onnx-loading-ipc-stub-child.mjs", import.meta.url)
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

  it("removes only its owned temporary tree after interruption during loading", async () => {
    const original = createForkLocalOnnxEmbeddingHost(loadingChildPath);
    let signalStage!: (paths: { root: string; outside: string }) => void;
    const staged = new Promise<{ root: string; outside: string }>(resolve => { signalStage = resolve; });
    const host: LocalOnnxEmbeddingIpcHost = { spawn() {
      const child = original.spawn();
      child.on("message", message => {
        if (typeof message === "object" && message !== null && "fixtureRoot" in message &&
            typeof message.fixtureRoot === "string" && "fixtureOutside" in message &&
            typeof message.fixtureOutside === "string") signalStage({ root: message.fixtureRoot, outside: message.fixtureOutside });
      });
      return child;
    } };
    const session = new LocalOnnxEmbeddingIpcSession({ modelId: "fixture", cacheDir: null, schemaVersion: 1, host });
    const warmup = session.warmup(new AbortController().signal);
    const warmupFailure = expect(warmup).rejects.toBeInstanceOf(LocalOnnxEmbeddingChildExitedError);
    const { root, outside } = await staged;
    try {
      expect(existsSync(root)).toBe(true);
      await session.close();
      await warmupFailure;
      expect(existsSync(root)).toBe(false);
      expect(existsSync(dirname(root))).toBe(false);
      expect(readFileSync(`${outside}/canary`, "utf8")).toBe("outside");
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }, 10_000);

  it("retains a failed owned-tree cleanup across sessions until the original close retries it", async () => {
    const inner = createForkLocalOnnxEmbeddingHost(loadingChildPath);
    const healthy = createForkLocalOnnxEmbeddingHost(stubChildPath);
    let spawns = 0;
    let signalStage!: (paths: { root: string; outside: string }) => void;
    const staged = new Promise<{ root: string; outside: string }>(resolve => { signalStage = resolve; });
    const host: LocalOnnxEmbeddingIpcHost = { spawn() {
      const child = ++spawns === 1 ? inner.spawn() : healthy.spawn();
      child.on("message", message => {
        if (typeof message === "object" && message !== null && "fixtureRoot" in message &&
            typeof message.fixtureRoot === "string" && "fixtureOutside" in message &&
            typeof message.fixtureOutside === "string") signalStage({ root: message.fixtureRoot, outside: message.fixtureOutside });
      });
      return child;
    } };
    const first = new LocalOnnxEmbeddingIpcSession({ modelId: "fixture", cacheDir: null, schemaVersion: 1, host });
    const successor = new LocalOnnxEmbeddingIpcSession({ modelId: "fixture", cacheDir: null, schemaVersion: 1, host });
    const warmupFailure = expect(first.warmup(new AbortController().signal)).rejects.toBeInstanceOf(LocalOnnxEmbeddingChildExitedError);
    const { root, outside } = await staged;
    const parent = dirname(root), parked = `${parent}-parked`;
    let displaced = false;
    try {
      renameSync(parent, parked);
      symlinkSync(parked, parent);
      displaced = true;
      await expect(first.close()).rejects.toThrow("private tree root is not a directory");
      await warmupFailure;
      await expect(successor.warmup(new AbortController().signal)).rejects.toThrow("private tree root is not a directory");
      expect(spawns).toBe(1);
      expect(existsSync(root)).toBe(true);
      unlinkSync(parent);
      renameSync(parked, parent);
      displaced = false;
      await expect(first.close()).resolves.toBeUndefined();
      expect(existsSync(root)).toBe(false);
      await expect(successor.warmup(new AbortController().signal)).resolves.toBeUndefined();
      expect(spawns).toBe(2);
    } finally {
      if (displaced) { unlinkSync(parent); renameSync(parked, parent); }
      await first.close().catch(() => first.close());
      await successor.close();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 10_000);

  it("does not release an unobserved exit after the kill grace or spawn a replacement", async () => {
    const unexiting = new NeverExitingChild();
    let spawns = 0;
    const host: LocalOnnxEmbeddingIpcHost = { spawn() {
      spawns++;
      return spawns === 1 ? unexiting : createForkLocalOnnxEmbeddingHost(stubChildPath).spawn();
    } };
    const session = new LocalOnnxEmbeddingIpcSession({ modelId: "fixture", cacheDir: null, schemaVersion: 1, host });
    const first = new AbortController();
    const pending = session.embedTexts(["ignored"], first.signal, 20_000);
    await unexiting.sent;
    first.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    await new Promise(resolve => setTimeout(resolve, 6_100));
    expect(unexiting.signals).toEqual(["SIGTERM", "SIGKILL"]);
    const next = new AbortController();
    const blocked = session.embedTexts(["ok"], next.signal, 5_000);
    next.abort(new Error("waiting caller cancelled"));
    await expect(blocked).rejects.toThrow("waiting caller cancelled");
    expect(spawns).toBe(1);
    unexiting.observeExit();
    await expect(session.embedTexts(["ok"], new AbortController().signal, 5_000)).resolves.toHaveLength(1);
    await session.close();
    expect(spawns).toBe(2);
  }, 12_000);

  it("reports an unobserved exit on close and retains its retirement until exit", async () => {
    const child = new NeverExitingChild();
    const session = new LocalOnnxEmbeddingIpcSession({
      modelId: "fixture", cacheDir: null, schemaVersion: 1, host: { spawn: () => child }
    });
    const pending = session.warmup(new AbortController().signal);
    const failedWarmup = expect(pending).rejects.toBeInstanceOf(LocalOnnxEmbeddingChildExitedError);
    await child.sent;
    await expect(session.close()).rejects.toThrow("exit was not observed");
    await failedWarmup;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.observeExit();
    await expect(session.close()).resolves.toBeUndefined();
  }, 9_000);

  it("fences a successor client after an unobserved close until exit, with bounded cancellation", async () => {
    const child = new NeverExitingChild();
    const live = createForkLocalOnnxEmbeddingHost(stubChildPath);
    let spawns = 0;
    const host: LocalOnnxEmbeddingIpcHost = { spawn() {
      return ++spawns === 1 ? child : live.spawn();
    } };
    const first = openClient(host);
    const loading = first.warmup();
    const failedLoading = expect(loading).rejects.toBeInstanceOf(LocalOnnxEmbeddingChildExitedError);
    await child.sent;
    await expect(first.close()).rejects.toThrow("exit was not observed");
    await failedLoading;

    const successor = openClient(host);
    const aborted = new AbortController();
    const waiting = successor.embedTexts(["ok"], { timeoutMs: 5_000, signal: aborted.signal });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(spawns).toBe(1);
    aborted.abort(new Error("caller cancelled while retiring"));
    await expect(waiting).rejects.toThrow("caller cancelled while retiring");
    const deadline = AbortSignal.timeout(40);
    await expect(successor.embedTexts(["ok"], { timeoutMs: 5_000, signal: deadline })).rejects.toThrow();
    expect(spawns).toBe(1);
    child.observeExit();
    await expect(successor.embedTexts(["ok"], { timeoutMs: 5_000 })).resolves.toHaveLength(1);
    expect(spawns).toBe(2);
    await first.close();
  }, 12_000);

  it("allows independent healthy clients to warm up concurrently", async () => {
    const stalled = new NeverExitingChild();
    const first = openClient({ spawn: () => stalled });
    const loading = first.warmup();
    const failedLoading = expect(loading).rejects.toBeInstanceOf(LocalOnnxEmbeddingChildExitedError);
    await stalled.sent;
    const second = openClient();
    await expect(second.warmup()).resolves.toBeUndefined();
    stalled.observeExit();
    await failedLoading;
    await first.close();
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

  it.each(["__non_finite__", "__overflow__", "__wrong_dimensions__"])("rejects invalid legacy child vector components: %s", async (probe) => {
    const client = openClient();
    await expect(client.embedTexts([probe], { timeoutMs: 5_000 })).rejects.toThrow(/finite|float32|dimensions/);
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

class NeverExitingChild extends EventEmitter implements LocalOnnxEmbeddingIpcProcess {
  public readonly exitCode = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly signals: NodeJS.Signals[] = [];
  private notifySent!: () => void;
  public readonly sent: Promise<void>;
  public constructor() {
    super();
    this.sent = new Promise(resolve => { this.notifySent = resolve; });
  }
  public send(): boolean { this.notifySent(); return true; }
  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean { this.signals.push(signal); return true; }
  public observeExit(): void { this.signalCode = "SIGKILL"; this.emit("exit", null, "SIGKILL"); }
}

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
