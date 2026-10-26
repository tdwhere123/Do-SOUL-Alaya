import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.clearAllMocks(); });
afterAll(() => { isolation.restore(); });
vi.mock("../../../ai/daemon-embedding-runtime.js", () => ({ createDaemonEmbeddingRuntime: vi.fn() }));
vi.mock("../../../runtime/recall/recall-read-worker-client.js", () => ({ createRecallReadWorkerClient: vi.fn() }));
vi.mock("../../../runtime/recall-materialization/recall-materialization-recall-runtime.js", () => ({
  createRecallSearchRuntime: vi.fn(() => ({})), createRecallServiceRuntime: vi.fn(() => ({})),
  createRecallUtilizationRuntime: vi.fn(() => ({}))
}));
vi.mock("../../../runtime/recall-materialization/recall-materialization-path-relation.js", () => ({
  createPathRelationRuntime: vi.fn(() => ({}))
}));
vi.mock("../../../runtime/recall-materialization/recall-materialization-edge-reconciliation.js", () => ({
  createEdgeAndReconciliationRuntime: vi.fn(async () => ({}))
}));
vi.mock("../../../runtime/recall-materialization/recall-materialization-router.js", () => ({
  createSignalMaterializationRuntime: vi.fn(() => ({}))
}));
import { createDaemonEmbeddingRuntime } from "../../../ai/daemon-embedding-runtime.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createRecallServiceRuntime } from "../../../runtime/recall-materialization/recall-materialization-recall-runtime.js";
import { createRecallMaterializationWiring, recallMaterializationWiringTestInternals } from "../../../runtime/recall-materialization/recall-materialization-wiring.js";
import type { CreateRecallMaterializationWiringInput } from "../../../runtime/recall-materialization/recall-materialization-wiring-types.js";
import { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { ORIGINAL, WS, digest, embedded, queryDatabase } from "./source-semantic-query-preparation-fixture.js";

const { closeRecallReadWorkerAfterStartupFailure } = recallMaterializationWiringTestInternals;

it("prepares only eligible active generations and preserves original/hint failures without extra inference", async () => {
  const h = await queryDatabase();
  // Wiring-only doubles: no daemon provider, model loading or inference is constructed.
  const embedInputs = vi.fn(async (inputs: Parameters<typeof embedded>[0]) => embedded(inputs));
  const bindSourceEmbedding = vi.fn(async () => ({ ...h.binding, embedInputs }));
  const embeddingRuntime = { bindSourceEmbedding, providerWarmup: Promise.resolve("disabled"),
    closeProvider: vi.fn(async () => undefined) } as unknown as ReturnType<typeof createDaemonEmbeddingRuntime>;
  vi.mocked(createDaemonEmbeddingRuntime).mockReturnValue(embeddingRuntime);
  const readSnapshot = { beginDeferred: vi.fn(), rollback: vi.fn(), commit: vi.fn() };
  const worker = { ready: vi.fn(async () => undefined), close: vi.fn(async () => undefined), readSnapshot } as
    unknown as NonNullable<ReturnType<typeof createRecallReadWorkerClient>>;
  vi.mocked(createRecallReadWorkerClient).mockReturnValue(worker);
  try {
    // Unrelated runtime phases above are isolated; Source selection reads still cross actual SQLite.
    const wiring = { database: h.database, pathReadBind: "temporal", globalMemoryRepo: null,
      configEnv: new Map(), warn: vi.fn(), eventPublisher: {}, relationAssertionRepo: {} } as unknown as CreateRecallMaterializationWiringInput;
    const result = await createRecallMaterializationWiring(wiring);
    expect(createDaemonEmbeddingRuntime).toHaveBeenCalledTimes(1);
    expect(createRecallReadWorkerClient).toHaveBeenCalledTimes(1);
    expect(createRecallServiceRuntime).toHaveBeenCalledWith(expect.objectContaining({ embeddingRuntime, readSnapshot }));
    expect(vi.mocked(createRecallServiceRuntime).mock.calls[0]![0].embeddingRuntime).toBe(embeddingRuntime);
    expect(result.recallReadWorkerClient).toBe(worker);
    expect(result.closeEmbeddingProvider).toBe(embeddingRuntime.closeProvider);
    const prepare = vi.mocked(createRecallReadWorkerClient).mock.calls[0]![0].prepareSourceQuery;
    expect(prepare).toBeTypeOf("function");
    const prepared = await prepare!({ workspace_id: WS, navigation: ORIGINAL,
      signal: new AbortController().signal, remainingMs: () => 1000 });
    expect(bindSourceEmbedding).toHaveBeenCalledExactlyOnceWith({
      window_bytes: h.selection.configuration.profile.window_bytes,
      max_input_tokens: h.selection.configuration.profile.max_input_tokens,
      windowing: h.selection.configuration.profile.windowing
    });
    expect(embedInputs.mock.calls[0]![0]).toEqual([{ input_id: digest(ORIGINAL), text: ORIGINAL, role: "query" }]);
    expect(prepared).toMatchObject({ receipt: { status: "ready", submitted_inputs: 1, token_count: 2,
      selected: { config_id: h.selection.config_id, profile_id: h.selection.profile_id } },
      vector: { status: "available", input_digest: digest(ORIGINAL) } });
    expect(createDaemonEmbeddingRuntime).toHaveBeenCalledTimes(1);
    expect(h.database.connection.inTransaction).toBe(false);
    h.database.connection.prepare("DELETE FROM source_index_vectors WHERE workspace_id=?").run(WS);
    expect(h.index.state(WS).status).toBe("partial");
    await prepare!({ workspace_id: WS, navigation: ORIGINAL, signal: new AbortController().signal, remainingMs: () => 1000 });
    expect(bindSourceEmbedding).toHaveBeenCalledTimes(2);
    expect(h.index.state(WS).status).toBe("partial"); // query inference never invents generation readiness
    const state = h.index.state(WS);
    if (state.status === "unknown" || state.active_generation_id === null) throw new Error("active partial required");
    h.index.fail(WS, state.active_generation_id, "build_failed");
    const preparation = { workspace_id: WS, navigation: ORIGINAL, supplemental_navigation: "distinct hint",
      signal: new AbortController().signal, remainingMs: () => 1000 };
    const failed = await prepare!(preparation);
    expect(failed).toMatchObject({ vector: { status: "unavailable", reason: "source_index_failed" },
      receipt: { navigation_digest: digest(ORIGINAL), submitted_inputs: 0 },
      supplemental: { vector: { status: "unavailable", reason: "source_index_failed" },
        receipt: { navigation_digest: digest("distinct hint"), submitted_inputs: 0 } } });
    h.index.unbind(WS);
    expect((await prepare!(preparation)).receipt.reason).toBe("source_index_unbound");
    expect(bindSourceEmbedding).toHaveBeenCalledTimes(2);
    const unavailable = vi.spyOn(SqliteSourceIndexRepository.prototype, "state").mockImplementation(() => { throw new Error("read failed"); });
    try {
      expect(await prepare!(preparation)).toMatchObject({
        receipt: { reason: "source_selection_unavailable", navigation_digest: digest(ORIGINAL) },
        supplemental: { vector: { status: "unavailable", reason: "source_selection_unavailable" },
          receipt: { reason: "source_selection_unavailable", navigation_digest: digest("distinct hint") } }
      });
      expect(bindSourceEmbedding).toHaveBeenCalledTimes(2);
    } finally { unavailable.mockRestore(); }
  } finally { h.cleanup(); }
});

describe("createRecallMaterializationWiring startup cleanup", () => {
  it("closes a started recall read worker and rethrows the original startup error", async () => {
    const startupError = new Error("config unavailable");
    const close = vi.fn(async () => undefined);
    const warn = vi.fn();

    await expect(
      closeRecallReadWorkerAfterStartupFailure({
        recallReadWorkerClient: { close },
        warn,
        error: startupError
      })
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on worker cleanup failure while preserving the startup error", async () => {
    const startupError = new Error("startup failed");
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    const warn = vi.fn();

    await expect(
      closeRecallReadWorkerAfterStartupFailure({
        recallReadWorkerClient: { close },
        warn,
        error: startupError
      })
    ).rejects.toBe(startupError);

    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "recall read worker startup cleanup failed",
      expect.objectContaining({ error: "close failed" })
    );
  });
});
