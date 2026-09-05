import { afterEach, describe, expect, it } from "vitest";
import { createEmbeddingIsolateDaemonAdapter } from
  "../../../runs/lifecycle/recall-eval/embedding-isolate/daemon-adapter.js";
import {
  freezeEmbeddingIsolateIdentity
} from "../../../runs/lifecycle/recall-eval/embedding-isolate/identity.js";
import {
  EmbeddingIsolateFailClosedError,
  P01_EMBEDDING_ISOLATE_CONTRACT,
  createEmbeddingIsolateSession,
  type EmbeddingIsolateHost,
  type EmbeddingIsolateSession
} from "../../../runs/lifecycle/recall-eval/embedding-isolate/session.js";
import { createStubEmbeddingIsolateHost } from
  "../../../runs/lifecycle/recall-eval/embedding-isolate/stub-host.js";
import {
  P00_PERFORMANCE_PROOF_CONTRACT,
  observedNumber
} from "../../../runs/lifecycle/recall-eval/performance-proof/attribution-receipt.js";
import { createRecallEvalPagerSession } from
  "../../../runs/lifecycle/recall-eval/recall-eval-process/ipc-client.js";

const IDENTITY = freezeEmbeddingIsolateIdentity({
  providerKind: "stub",
  modelId: "stub-mini",
  vectorSpace: "stub:4",
  schemaVersion: 1,
  artifactId: "stub-artifact-v1"
});

const sessions: EmbeddingIsolateSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
});

describe("P01 embedding isolate lifetime", () => {
  it("cites the P00 attribution and exact-parity contract", () => {
    expect(P01_EMBEDDING_ISOLATE_CONTRACT.cites).toBe(P00_PERFORMANCE_PROOF_CONTRACT.name);
    expect(P01_EMBEDDING_ISOLATE_CONTRACT.cites).toBe(
      "recall-eval-performance-attribution-and-exact-parity.v1"
    );
  });

  it("does not delete pager recycle", () => {
    const pager = createRecallEvalPagerSession({
      host: {
        spawn() {
          throw new Error("pager child must not spawn in the isolate lifetime test");
        }
      }
    });
    expect(typeof pager.recycle).toBe("function");
  });

  it("rejects execution_arch and reference|optimized in isolate identity", () => {
    expect(() => freezeEmbeddingIsolateIdentity({
      ...IDENTITY,
      modelId: "reference|optimized"
    })).toThrow(/reference\|optimized/u);
    expect(() => freezeEmbeddingIsolateIdentity({
      ...IDENTITY,
      artifactId: "execution_arch"
    })).toThrow(/execution_arch/u);
  });
});

describe("A1 one model-child per compatible pager session", () => {
  it("spawns and readies the owner once across two workspace questions", async () => {
    const { session, host, adapter } = await openAdapter();
    const first = await adapter.startWorkspace(daemonStart("ws-a"));
    const ownerPid = session.inspectAttribution().liveChildPids[0];
    await session.embed(first.lease, ["question-a"]);
    await first.shutdown();

    const second = await adapter.startWorkspace(daemonStart("ws-b"));
    await session.embed(second.lease, ["question-b"]);
    expect(session.inspectAttribution()).toMatchObject({
      modelChildSpawnCount: { status: "observed", value: 1 },
      modelReadinessCount: { status: "observed", value: 1 },
      liveChildCount: { status: "observed", value: 1 },
      liveChildPids: [ownerPid]
    });
    expect(host.killCount).toBe(0);
    await second.shutdown();
    expect(host.livePids).toEqual([ownerPid]);
    expect(session.inspectRetained().modelReady).toBe(true);
  });
});

describe("A2 immutable lease identity and no workspace carry-over", () => {
  it("binds the identical identity and exposes no workspace state to the next question", async () => {
    const { session, adapter } = await openAdapter();
    const first = await adapter.startWorkspace(daemonStart("ws-a"));
    expect(first.lease.identity).toEqual(IDENTITY);
    const beforeEmbed = session.inspectRetained();
    await session.embed(first.lease, ["retain-me"]);
    expect(session.inspectRetained()).toEqual(beforeEmbed);
    expect(session.inspectRetained().queryEmbeddingResults).toEqual([]);
    expect(session.inspectRetained().documentObservations).toEqual([]);
    expect(session.inspectRetained().recallCandidates).toEqual([]);
    expect(session.inspectRetained().workspaceHandles).toEqual([]);
    expect(session.inspectRetained().selectionState).toEqual([]);
    expect(session.inspectRetained().deliveryResults).toEqual([]);
    await first.shutdown();
    expect(session.inspectRetained().activeLease).toBeNull();

    const second = await adapter.startWorkspace(daemonStart("ws-b"));
    expect(second.lease.identity).toEqual(IDENTITY);
    expect(second.lease.workspaceId).toBe("ws-b");
    expect(session.inspectRetained().activeLease?.workspaceId).toBe("ws-b");
    expect(session.inspectRetained().activeLease?.workspaceId).not.toBe("ws-a");
    await second.shutdown();
  });
});

describe("A4 fail-closed reaps every process", () => {
  it("reaps on identity mismatch and uncertain claims", async () => {
    const { session, host } = await openSession();
    expect(() => session.lease({ ...IDENTITY, modelId: "other-model" }, "ws-a"))
      .toThrow(EmbeddingIsolateFailClosedError);
    expect(session.deadReason).toBe("mismatch");
    expectZero(session, host);

    const uncertain = await openSession();
    expect(() => uncertain.session.lease({ ...IDENTITY, modelId: "unknown" }, "ws-a"))
      .toThrow(EmbeddingIsolateFailClosedError);
    expect(uncertain.session.deadReason).toBe("uncertain");
    expectZero(uncertain.session, uncertain.host);
  });

  it("reaps on warmup timeout and cancellation", async () => {
    const timeout = await openHangingSession();
    await expect(timeout.session.open({ timeoutMs: 40 }))
      .rejects.toMatchObject({ name: "EmbeddingIsolateFailClosedError", reason: "timeout" });
    expectZero(timeout.session, timeout.host);

    const cancelling = await openHangingSession();
    const abort = new AbortController();
    const pending = cancelling.session.open({ timeoutMs: 5_000, signal: abort.signal });
    abort.abort();
    await expect(pending)
      .rejects.toMatchObject({ name: "EmbeddingIsolateFailClosedError", reason: "cancellation" });
    expectZero(cancelling.session, cancelling.host);
  });

  it("reaps on daemon-start failure, pager recycle, and normal close", async () => {
    const startFail = await openAdapter();
    await expect(startFail.adapter.startWorkspace({
      workspaceId: "ws-a",
      claimedIdentity: IDENTITY,
      start: async () => {
        throw new Error("synthetic daemon start failure");
      }
    })).rejects.toMatchObject({
      name: "EmbeddingIsolateFailClosedError",
      reason: "daemon-start-failure"
    });
    expect(startFail.adapter.liveDaemonPids()).toEqual([]);
    expectZero(startFail.session, startFail.host);

    const recycled = await openAdapter();
    const leased = await recycled.adapter.startWorkspace(daemonStart("ws-a"));
    expect(typeof leased.handle.pid).toBe("number");
    await recycled.adapter.recyclePager();
    expect(recycled.session.deadReason).toBe("pager-recycle");
    expect(recycled.adapter.liveDaemonPids()).toEqual([]);
    expectZero(recycled.session, recycled.host);
    expect(() => recycled.session.lease(IDENTITY, "ws-b"))
      .toThrow(EmbeddingIsolateFailClosedError);

    const closed = await openAdapter();
    const running = await closed.adapter.startWorkspace(daemonStart("ws-a"));
    expect(running.handle.pid).toBeDefined();
    await closed.adapter.close();
    await closed.adapter.close();
    expect(closed.host.killCount).toBe(1);
    expect(closed.adapter.liveDaemonPids()).toEqual([]);
    expectZero(closed.session, closed.host);
  });

  it("kills a child that emits error without exit", async () => {
    const { session, host } = await openSession();
    expect(host.livePids).toHaveLength(1);
    host.emitError(new Error("ipc transport failed"));
    expect(session.deadReason).toBe("child-exit");
    expectZero(session, host);
    expect(host.killCount).toBe(1);
  });

  it("reaps a hanging daemon start that later resolves", async () => {
    const { session, host, adapter } = await openAdapter();
    let daemonLive = false;
    const pending = adapter.startWorkspace({
      workspaceId: "ws-a",
      claimedIdentity: IDENTITY,
      start: () => new Promise((resolve) => {
        setTimeout(() => {
          daemonLive = true;
          resolve({
            pid: 8801,
            async shutdown() {
              daemonLive = false;
            }
          });
        }, 80);
      })
    }, { timeoutMs: 20 });
    await expect(pending).rejects.toMatchObject({
      name: "EmbeddingIsolateFailClosedError",
      reason: "timeout"
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(daemonLive).toBe(false);
    expect(adapter.liveDaemonPids()).toEqual([]);
    expectZero(session, host);
  });

  it("does not release the lease when daemon shutdown throws", async () => {
    const { session, adapter } = await openAdapter();
    const leased = await adapter.startWorkspace({
      workspaceId: "ws-a",
      claimedIdentity: IDENTITY,
      async start() {
        return {
          pid: 8802,
          async shutdown() {
            throw new Error("daemon shutdown failed");
          }
        };
      }
    });
    await expect(leased.shutdown()).rejects.toMatchObject({
      name: "EmbeddingIsolateFailClosedError",
      reason: "uncertain"
    });
    expect(session.isDead).toBe(true);
    expect(adapter.liveDaemonPids()).toEqual([8802]);
    expect(() => session.lease(IDENTITY, "ws-b")).toThrow(EmbeddingIsolateFailClosedError);
  });
});

describe("A5 Clock-A stays separate from isolate readiness", () => {
  it("does not reclassify model readiness as Clock-A", async () => {
    const { session } = await openSession();
    const clocks = session.inspectAttribution();
    expect(clocks.clockAMs).toEqual({
      status: "not_observed",
      reason: "embedding isolate does not execute daemon.recall"
    });
    expect(clocks.modelReadinessMs.status).toBe("observed");
    if (clocks.modelReadinessMs.status !== "observed") {
      throw new Error("model readiness should be observed after open");
    }
    expect(clocks.modelReadinessMs.value).toBeGreaterThanOrEqual(0);
    expect("value" in clocks.clockAMs).toBe(false);

    const injected = await openSession({ clockAMs: observedNumber(0) });
    expect(injected.session.inspectAttribution().clockAMs).toEqual({
      status: "observed",
      value: 0
    });
    expect(injected.session.inspectAttribution().modelReadinessCount).toEqual({
      status: "observed",
      value: 1
    });
  });
});

async function openSession(
  input: { readonly clockAMs?: ReturnType<typeof observedNumber> } = {}
): Promise<{
  readonly session: EmbeddingIsolateSession;
  readonly host: ReturnType<typeof createStubEmbeddingIsolateHost>;
}> {
  const host = createStubEmbeddingIsolateHost();
  const session = createEmbeddingIsolateSession({
    identity: IDENTITY,
    host,
    ...input
  });
  sessions.push(session);
  await session.open();
  return { session, host };
}

async function openAdapter(): Promise<{
  readonly session: EmbeddingIsolateSession;
  readonly host: ReturnType<typeof createStubEmbeddingIsolateHost>;
  readonly adapter: ReturnType<typeof createEmbeddingIsolateDaemonAdapter>;
}> {
  const opened = await openSession();
  const adapter = createEmbeddingIsolateDaemonAdapter({ session: opened.session });
  return { ...opened, adapter };
}

async function openHangingSession(): Promise<{
  readonly session: EmbeddingIsolateSession;
  readonly host: ReturnType<typeof createStubEmbeddingIsolateHost>;
}> {
  const inner = createStubEmbeddingIsolateHost();
  const host: EmbeddingIsolateHost & ReturnType<typeof createStubEmbeddingIsolateHost> = {
    spawn: (identity) => inner.spawn(identity),
    warmup: () => new Promise(() => undefined),
    get killCount() {
      return inner.killCount;
    },
    get livePids() {
      return inner.livePids;
    }
  };
  const session = createEmbeddingIsolateSession({ identity: IDENTITY, host, timeoutMs: 40 });
  sessions.push(session);
  return { session, host };
}

function daemonStart(workspaceId: string): {
  readonly workspaceId: string;
  readonly claimedIdentity: typeof IDENTITY;
  readonly start: () => Promise<{ pid: number; shutdown(): Promise<void> }>;
} {
  let nextPid = 7000 + Math.floor(Math.random() * 1000);
  return {
    workspaceId,
    claimedIdentity: IDENTITY,
    async start() {
      const pid = nextPid;
      nextPid += 1;
      let stopped = false;
      return {
        pid,
        async shutdown() {
          stopped = true;
          void stopped;
        }
      };
    }
  };
}

function expectZero(
  session: EmbeddingIsolateSession,
  host: ReturnType<typeof createStubEmbeddingIsolateHost>
): void {
  expect(session.inspectAttribution().liveChildCount).toEqual({
    status: "observed",
    value: 0
  });
  expect(session.inspectAttribution().activeLeaseCount).toEqual({
    status: "observed",
    value: 0
  });
  expect(session.inspectAttribution().liveChildPids).toEqual([]);
  expect(host.livePids).toEqual([]);
}
