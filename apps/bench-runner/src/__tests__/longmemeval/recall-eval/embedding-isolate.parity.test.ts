import { afterEach, describe, expect, it } from "vitest";
import { createEmbeddingIsolateDaemonAdapter } from
  "../../../runs/lifecycle/recall-eval/embedding-isolate/daemon-adapter.js";
import { freezeEmbeddingIsolateIdentity } from
  "../../../runs/lifecycle/recall-eval/embedding-isolate/identity.js";
import {
  P01_EMBEDDING_ISOLATE_CONTRACT,
  createEmbeddingIsolateSession,
  type EmbeddingIsolateSession
} from "../../../runs/lifecycle/recall-eval/embedding-isolate/session.js";
import { createStubEmbeddingIsolateHost } from
  "../../../runs/lifecycle/recall-eval/embedding-isolate/stub-host.js";
import { P00_PERFORMANCE_PROOF_CONTRACT } from
  "../../../runs/lifecycle/recall-eval/performance-proof/attribution-receipt.js";
import { compareExactParity } from
  "../../../runs/lifecycle/recall-eval/performance-proof/exact-parity.js";
import {
  hasResourceLeak,
  runProviderFreePerformanceProof
} from "../../../runs/lifecycle/recall-eval/performance-proof/provider-free-run.js";

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

describe("A3 isolate-composed provider-free exact parity", () => {
  it("keeps P00 control result bytes across two isolate-leased workspaces", async () => {
    expect(P01_EMBEDDING_ISOLATE_CONTRACT.cites).toBe(P00_PERFORMANCE_PROOF_CONTRACT.name);

    const control = await runProviderFreePerformanceProof();
    const host = createStubEmbeddingIsolateHost();
    const session = createEmbeddingIsolateSession({ identity: IDENTITY, host });
    sessions.push(session);
    await session.open();
    const adapter = createEmbeddingIsolateDaemonAdapter({ session });

    const first = await runQuestion(adapter, session, "ws-a");
    const second = await runQuestion(adapter, session, "ws-b");
    const comparison = compareExactParity(first.receipt, second.receipt);
    const versusControl = compareExactParity(control.receipt, first.receipt);

    expect(comparison.identityBound).toBe(true);
    expect(comparison.resultEquivalent).toBe(true);
    expect(comparison.byteCountEquivalent).toBe(true);
    expect(versusControl.identityBound).toBe(true);
    expect(versusControl.resultEquivalent).toBe(true);
    expect(versusControl.byteCountEquivalent).toBe(true);
    expect(first.receipt.result.deliveredObjectIds).toEqual(["mem-a", "mem-b"]);
    expect(first.receipt.result.providerCalls).toEqual([]);
    expect(first.receipt.result.cacheCalls).toEqual([]);
    expect(first.receipt.result.sourceDigestBefore).toBe(control.receipt.result.sourceDigestBefore);
    expect(first.receipt.result.overlayDigestAfter).toBe(control.receipt.result.overlayDigestAfter);
    expect(hasResourceLeak(control.leaks)).toBe(false);
    expect(hasResourceLeak(first.leaks)).toBe(false);
    expect(hasResourceLeak(second.leaks)).toBe(false);
    expect(session.inspectAttribution().modelChildSpawnCount).toEqual({
      status: "observed",
      value: 1
    });
    expect(session.inspectAttribution().modelReadinessCount).toEqual({
      status: "observed",
      value: 1
    });
    expect(session.inspectAttribution().clockAMs.status).toBe("not_observed");
    expect(session.inspectAttribution().modelReadinessMs.status).toBe("observed");
    expect("value" in session.inspectAttribution().clockAMs).toBe(false);

    await adapter.close();
    expect(host.livePids).toEqual([]);
    expect(session.inspectAttribution().liveChildCount).toEqual({
      status: "observed",
      value: 0
    });
    expect(session.inspectAttribution().activeLeaseCount).toEqual({
      status: "observed",
      value: 0
    });
  });
});

async function runQuestion(
  adapter: ReturnType<typeof createEmbeddingIsolateDaemonAdapter>,
  session: EmbeddingIsolateSession,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof runProviderFreePerformanceProof>>> {
  const leased = await adapter.startWorkspace({
    workspaceId,
    claimedIdentity: IDENTITY,
    async start() {
      return {
        pid: workspaceId === "ws-a" ? 7100 : 7101,
        async shutdown() {
          return;
        }
      };
    }
  });
  try {
    await session.embed(leased.lease, [`question-${workspaceId}`]);
    return await runProviderFreePerformanceProof();
  } finally {
    await leased.shutdown();
  }
}
