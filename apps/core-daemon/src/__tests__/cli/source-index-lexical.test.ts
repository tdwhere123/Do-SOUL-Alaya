import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { __resetCjkSegmentationStateForTests, __setCjkSegmentationLoaderForTests } from "@do-soul/alaya-cjk-segmentation";
import { initDatabase, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { createAlayaCliBridge } from "../../cli/bridge.js";
import { createSourceIndexLexicalCommand } from "../../cli/source-index-lexical.js";
import { createCoreDaemonLifecycleState, createDaemonLifecycleControls } from "../../runtime/daemon/lifecycle/daemon-runtime-lifecycle.js";
import { createSourceIndexProducer } from "../../runtime/source-index/source-index-producer.js";
import { fieldSha256, fixture, publishSource, WORKSPACE } from "../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";

afterEach(() => { __resetCjkSegmentationStateForTests(); vi.restoreAllMocks(); });

function bridgeFor(runtime: Parameters<typeof createSourceIndexLexicalCommand>[0]) {
  const bridge = createAlayaCliBridge({ startupSteps: [{ step: "http-app", completedAt: "2026-10-28T00:00:00.000Z" }] }, {
    env: {}, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), isTTY: false
  });
  bridge.registerSubcommand(createSourceIndexLexicalCommand(runtime));
  return bridge;
}

it.each([false, true])("selects v2 through the CLI and persists the bounded lexical pass (partial=%s)", async partial => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-lexical-cli-"));
  const filename = join(directory, "alaya.db");
  const environment = fixture(filename);
  publishSource(environment, "deployment workflow", "cli-source");
  const previous = environment.index.lexical.selectLexical(WORKSPACE, "segmented-unicode61.v1");
  __setCjkSegmentationLoaderForTests(async () => ({ cut: token => [token] }));
  const bind = vi.fn(async () => ({ status: "unsupported" as const, reason: "provider_disabled" }));
  const producer = createSourceIndexProducer({ database: environment.database, bindSourceEmbedding: bind,
    warn: vi.fn(), ...(partial ? { limits: { work: 8 } } : {}) });
  const controls = createDaemonLifecycleControls({ app: { fetch: async () => new Response("ok") },
    lifecycleState: createCoreDaemonLifecycleState(), warnLogger: { warn: vi.fn() }, sourceIndexProducer: producer,
    gardenBacklogTelemetryService: { start: vi.fn(), stop: vi.fn(async () => undefined) },
    gardenRuntime: { backgroundManager: { start: vi.fn(), stop: vi.fn(async () => undefined) },
      setBacklogTelemetryObserver: vi.fn(), runBackgroundPass: vi.fn(async () => undefined),
      runBulkEnrichPass: vi.fn(async () => undefined), runEmbeddingBackfillPass: vi.fn(async () => undefined) },
    securityStatusService: { close: vi.fn() }, daemonMcpRuntimeRegistry: { close: vi.fn(async () => undefined) },
    globalMemoryRecallInvalidationSubscription: null, database: environment.database,
    requestProtection: { requestToken: "fixture-token", tokenSource: "env", allowedOrigin: "http://localhost" }
  });
  try {
    const result = await bridgeFor(controls).dispatch(["source-index-lexical", "select", "--workspace", WORKSPACE,
      "--representation", "segmented-unicode61.v2", "--json"]);
    expect(result.exitCode).toBe(partial ? 75 : 0);
    expect(result.json).toMatchObject({ action: "select", status: partial ? "partial" : "ready", model_inputs: 0,
      selection: { workspace_id: WORKSPACE, representation: "segmented-unicode61.v2", selection_revision: previous.selection_revision + 1 } });
    expect(bind).not.toHaveBeenCalled();
    await controls.shutdown();
    const reopened = initDatabase({ filename });
    try {
      const state = new SqliteSourceIndexRepository(reopened, fieldSha256).lexical.lexicalState(WORKSPACE);
      expect(state?.selection.representation).toBe("segmented-unicode61.v2");
      expect(state?.active_generation_id === null).toBe(partial);
    } finally { reopened.close(); }
  } finally {
    await controls.shutdown();
    if (!environment.database.isClosed()) environment.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  { condition: "missing representation", args: ["select", "--workspace", WORKSPACE] },
  { condition: "unsupported representation", args: ["select", "--workspace", WORKSPACE, "--representation", "unknown"] },
  { condition: "duplicate workspace", args: ["select", "--workspace", WORKSPACE, "--workspace", WORKSPACE, "--representation", "raw-unicode61.v1"] }
])("refuses $condition before runtime writes", async ({ args }) => {
  const runSourceIndexLexicalPass = vi.fn();
  const result = await bridgeFor({ runSourceIndexLexicalPass }).dispatch(["source-index-lexical", ...args]);
  expect(result.exitCode).toBe(64);
  expect(runSourceIndexLexicalPass).not.toHaveBeenCalled();
});

it("reports an unavailable runtime capability without claiming a selected representation", async () => {
  const result = await bridgeFor({}).dispatch(["source-index-lexical", "select", "--workspace", WORKSPACE,
    "--representation", "raw-unicode61.v1"]);
  expect(result.exitCode).toBe(75);
  expect(result.json).toEqual({ status: "unavailable", reason: "producer_not_wired" });
});
