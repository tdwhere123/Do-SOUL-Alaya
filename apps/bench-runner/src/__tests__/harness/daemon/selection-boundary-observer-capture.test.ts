import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AlayaDaemonRuntime } from "@do-soul/alaya";
import type { FineAssessmentSelectionBoundaryPendingCapture } from
  "@do-soul/alaya-core";
import { describe, expect, it, vi } from "vitest";

const { invokeBoundRecall } = vi.hoisted(() => ({
  invokeBoundRecall: vi.fn()
}));

vi.mock("@do-soul/alaya/recall/bound-execution", () => ({
  invokeBoundRecall
}));

import { createBenchDaemonOps } from
  "../../../harness/daemon/handle/daemon-handle-ops.js";

describe("bench daemon selection-boundary observer", () => {
  it("requests answer features by default for benchmark treatment diagnostics", async () => {
    const operations = createOperations({});
    const observer = vi.fn(
      (_pending: FineAssessmentSelectionBoundaryPendingCapture) => undefined
    );
    const captured = await invokeThenStop(() =>
      operations.recall("Where do I take yoga classes?", {
        selectionBoundaryObserver: observer
      })
    );

    expect(captured.selectionBoundaryObserver).toBe(observer);
    expect(captured.diagnosticCapture).toBe("answer_features");
  });

  it("still uses packet_trace only when that diagnostic env is set", async () => {
    const operations = createOperations({
      ALAYA_BENCH_RECALL_PACKET_TRACE: "1"
    });
    const observer = vi.fn(
      (_pending: FineAssessmentSelectionBoundaryPendingCapture) => undefined
    );
    const captured = await invokeThenStop(() =>
      operations.recall("Where do I take yoga classes?", {
        selectionBoundaryObserver: observer
      })
    );

    expect(captured.selectionBoundaryObserver).toBe(observer);
    expect(captured.diagnosticCapture).toBe("packet_trace");
  });
});

async function invokeThenStop(
  run: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  invokeBoundRecall.mockReset();
  invokeBoundRecall.mockImplementation(async (params: Record<string, unknown>) => {
    throw Object.assign(new Error("stop-after-bound-recall-invoke"), { params });
  });
  const error = await run().then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toMatchObject({ message: "stop-after-bound-recall-invoke" });
  expect(invokeBoundRecall).toHaveBeenCalledOnce();
  return (error as { params: Record<string, unknown> }).params;
}

function createOperations(
  effectiveEnv: Readonly<Record<string, string | undefined>>
) {
  return createBenchDaemonOps({
    dataDir: "/unused",
    activeContext: { workspaceId: "workspace-1", runId: "run-1" },
    activeRuntime: {
      services: { recallService: { recall: vi.fn() } }
    } as unknown as AlayaDaemonRuntime,
    activeServer: { close: async () => undefined },
    activeMcpClient: {} as Client,
    dispatchCli: async () => ({ exitCode: 0 }),
    embeddingMode: "disabled",
    embeddingProviderKind: "local_onnx",
    effectiveEnv,
    savedEnv: {},
    managedEnvKeys: [],
    reviewerCredentials: { identity: "bench-reviewer", token: "bench-token" },
    cleanupConfigDirectory: async () => undefined,
    releaseActive: () => undefined,
    cleanupManagedWorkspaceRoots: async () => undefined
  });
}
