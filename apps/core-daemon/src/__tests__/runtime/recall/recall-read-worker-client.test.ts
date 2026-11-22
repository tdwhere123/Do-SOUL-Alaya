import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreError,
  RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE,
  RecallService,
  recallExecutionRetention
} from "@do-soul/alaya-core";
import {
  ControlPlaneObjectKind,
  InformationIndexSchema,
  QUERY_PROPOSAL_MAX_AST_DEPTH,
  QUERY_PROPOSAL_MAX_AST_NODES,
  RetentionPolicy,
  SoulMemorySearchRequestSchema,
  TaskObjectSurfaceSchema,
  unavailableSourceQueryPreparation,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import {
  closeCachedDatabase,
  initDatabase,
  prepareIndexedRecallProjection,
  SqliteMemoryEntryRepo
} from "@do-soul/alaya-storage";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { runOperation } from "../../../runtime/recall-read-worker/dispatch.js";
import {
  ConditionalFieldRecallWorkerPayloadSchema,
  RECALL_READ_WORKER_PROTOCOL_VERSION
} from "../../../runtime/recall-read-worker/protocol.js";
import { normalizeRequestTimeoutMs } from "../../../runtime/recall-read-worker/client-config.js";
import {
  claimDeliverySettlement,
  createDeliverySettlement,
  finishDeliverySettlement
} from "../../../runtime/recall-read-worker/delivery-settlement.js";
import {
  acknowledgeWorkerDelivery,
  discardWorkerDelivery,
  prepareWorkerDelivery
} from "../../../runtime/recall-read-worker/prepared-delivery.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import {
  conditionalRecallPayload,
  createQueryOnlyRuntime,
  encodeWorkerRecallPayload
} from "../field/query-only-hydration-fixture.js";
import { identityAssociationCap } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import {
  assertBuiltWorker,
  builtWorkerUrl,
  createMemoryEntry
} from "./recall-read-worker-client-fixture.js";

describe("RecallReadWorkerClient", () => {
  it("resolves the built worker from source instead of silently using direct sqlite", async () => {
    expect(existsSync(fileURLToPath(builtWorkerUrl))).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "alaya-source-runtime-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    prepareIndexedRecallProjection(database);
    database.close();
    closeCachedDatabase(databasePath);
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath
    });
    try {
      expect(client).not.toBeNull();
    } finally {
      await client?.close();
      removeTempDirectorySync(directory);
    }
  });

  it("refuses :memory: and a missing worker unless direct sqlite is explicit", () => {
    expect(() => createRecallReadWorkerClient({ databaseFilename: ":memory:" }))
      .toThrow(/allowDirectSqliteRecallReads/);
    const warn = vi.fn();
    expect(createRecallReadWorkerClient({
      databaseFilename: ":memory:",
      allowDirectSqliteRecallReads: true,
      warn
    })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "recall read worker degraded to direct sqlite because allowDirectSqliteRecallReads is set",
      expect.objectContaining({ reason: "direct_sqlite_recall_reads" })
    );
  });

  // 900 file-backed inserts plus worker open regularly exceed 30s on NTFS.
  it("keeps the daemon event loop available during a file-backed SQLite recall read", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const repo = new SqliteMemoryEntryRepo(database);
    const workspaceId = "workspace-1";
    const rowCount = 900;

    try {
      for (let index = 0; index < rowCount; index += 1) {
        await repo.create(createMemoryEntry({
          object_id: randomUUID(),
          workspace_id: workspaceId,
          content: `Worker recall load row ${index}`,
          activation_score: 1 - index / rowCount
        }));
      }
      // Parent must release the file before the worker opens it; Windows can
      // hang worker RPC while the parent still holds the same SQLite handle.
      database.close();
      closeCachedDatabase(databasePath);

      const client = createRecallReadWorkerClient({
        databaseFilename: databasePath,
        workerUrl: builtWorkerUrl
      });
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      try {
        await expect(client.ready()).resolves.toBeUndefined();
        const startedAt = performance.now();
        const timerDelayPromise = new Promise<number>((resolve) => {
          setTimeout(() => resolve(performance.now() - startedAt), 0);
        });
        const rowsPromise = client.activeConstraintsPort.findActiveConstraints({
          workspaceId,
          cap: rowCount
        });

        await expect(timerDelayPromise).resolves.toBeLessThan(50);
        await expect(rowsPromise).resolves.toMatchObject({ constraints: expect.any(Array) });
      } finally {
        await client.close();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(directory);
    }
  }, process.platform === "win32" ? 120_000 : 30_000);

  it.skipIf(process.platform === "win32")(
    "restarts the worker after a request timeout",
    async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-timeout-test-"));
    const workerPath = join(directory, "silent-worker.mjs");
    const databasePath = join(directory, "alaya.db");
    writeFileSync(
      workerPath,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import { parentPort, workerData } from "node:worker_threads";',
        'const marker = `${workerData.databaseFilename}.restart`;',
        'if (!existsSync(marker)) {',
        '  writeFileSync(marker, "ready", "utf8");',
        '  parentPort?.on("message", () => {});',
        '} else {',
        '  parentPort?.on("message", ({ id, operation }) => {',
        '    parentPort?.postMessage({ id, ok: true, result: operation === "close" || operation === "ready" ? null : [] });',
        '  });',
        '}',
        ''
      ].join("\n")
    );
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1,
      requestTimeoutMs: 1000
    });

    try {
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      await expect(client.ready()).rejects.toThrow("timed out after 1000ms");
      await expect(client.ready()).resolves.toBeUndefined();
    } finally {
      await client?.close();
      removeTempDirectorySync(directory);
    }
  }, 30_000);

  it("terminates a silent worker and settles close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-close-timeout-test-"));
    const workerPath = join(directory, "silent-worker.mjs");
    writeFileSync(
      workerPath,
      `import { parentPort } from "node:worker_threads";\nparentPort?.on("message", () => {});\n`
    );
    const client = createRecallReadWorkerClient({
      databaseFilename: join(directory, "alaya.db"),
      workerUrl: pathToFileURL(workerPath),
      workerCount: 1,
      requestTimeoutMs: 5
    });

    try {
      expect(client).not.toBeNull();
      if (client === null) {
        return;
      }

      await expect(client.close()).resolves.toBeUndefined();
      await expect(client.ready()).rejects.toThrow(
        "recall read worker is closed"
      );
    } finally {
      await client?.close();
      removeTempDirectorySync(directory);
    }
  }, 30_000);

  it("processes concurrent worker requests sequentially with intact request ids", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-serial-test-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const repo = new SqliteMemoryEntryRepo(database);
    const workspaceId = "workspace-1";

    try {
      for (let index = 0; index < 40; index += 1) {
        await repo.create(createMemoryEntry({
          object_id: randomUUID(),
          workspace_id: workspaceId,
          content: `Serial worker row ${index}`,
          activation_score: 1 - index / 40
        }));
      }
      database.close();
      closeCachedDatabase(databasePath);

      const worker = new Worker(fileURLToPath(builtWorkerUrl), {
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
        workerData: { databaseFilename: databasePath }
      });

      try {
        const responses = await collectWorkerResponses(worker, [
          { protocol_version: 1, id: 11, operation: "ready", payload: {} },
          { protocol_version: 1, id: 12, operation: "ready", payload: {} },
          { protocol_version: 1, id: 13, operation: "ready", payload: {} }
        ]);

        expect(responses.map((response) => response.id)).toEqual([11, 12, 13]);
        expect(responses[0]).toMatchObject({ ok: true, result: null });
        expect(responses[1]).toMatchObject({ ok: true, result: null });
        expect(responses[2]).toMatchObject({ ok: true, result: null });
      } finally {
        await worker.terminate();
      }
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(directory);
    }
  }, 15_000);

  it("rejects a numeric-id message that fails request validation promptly", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-invalid-msg-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    prepareIndexedRecallProjection(database);
    database.close();
    closeCachedDatabase(databasePath);

    const worker = new Worker(fileURLToPath(builtWorkerUrl), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: { databaseFilename: databasePath }
    });

    try {
      const invalidResponse = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("invalid request did not receive a prompt error response")),
          10_000
        );
        worker.once("message", (message: unknown) => {
          clearTimeout(timeout);
          resolve(message);
        });
        worker.postMessage({ id: 42, operation: 123 });
      });

      expect(invalidResponse).toEqual({
        id: 42,
        ok: false,
        error: expect.objectContaining({
          name: "Error",
          message: "invalid recall read worker request"
        })
      });

      const validResponse = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("worker did not survive after invalid request")),
          2_000
        );
        worker.once("message", (message: unknown) => {
          clearTimeout(timeout);
          resolve(message);
        });
        worker.postMessage({
          protocol_version: 1,
          id: 43,
          operation: "ready",
          payload: {}
        });
      });

      expect(validResponse).toEqual({
        id: 43,
        ok: true,
        result: null
      });
    } finally {
      await worker.terminate();
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(directory);
    }
  }, 30_000);

  it("rejects a worker envelope missing protocol_version", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-missing-protocol-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    prepareIndexedRecallProjection(database);
    database.close();
    closeCachedDatabase(databasePath);

    const worker = new Worker(fileURLToPath(builtWorkerUrl), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: { databaseFilename: databasePath }
    });

    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("missing protocol_version did not receive a prompt error response")),
          10_000
        );
        worker.once("message", (message: unknown) => {
          clearTimeout(timeout);
          resolve(message);
        });
        worker.postMessage({
          id: 7,
          operation: "ready",
          payload: {}
        });
      });
      expect(response).toEqual({
        id: 7,
        ok: false,
        error: expect.objectContaining({
          message: "invalid recall read worker request"
        })
      });
    } finally {
      await worker.terminate();
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(directory);
    }
  }, 30_000);

  it("rejects an invalid conditionalField.recall payload instead of inventing an empty index", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-invalid-payload-"));
    const database = initDatabase({ filename: join(directory, "alaya.db") });
    try {
      await expect(runOperation(createQueryOnlyRuntime(database), {
        protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION,
        id: 1,
        operation: "conditionalField.recall",
        payload: { workspace_id: "workspace-1" }
      })).rejects.toThrow();
    } finally {
      database.close();
      closeCachedDatabase(database.filename);
      removeTempDirectorySync(directory);
    }
  });

  it("round-trips cap_contracts through conditionalField.recall", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-cap-roundtrip-"));
    const database = initDatabase({ filename: join(directory, "alaya.db") });
    prepareIndexedRecallProjection(database);
    try {
      const cap = identityAssociationCap();
      const result = await runOperation(createQueryOnlyRuntime(database), {
        protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION,
        id: 1,
        operation: "conditionalField.recall",
        payload: encodeWorkerRecallPayload({
          ...conditionalRecallPayload("needle"),
          cap_contracts: [cap]
        })
      }) as {
        readonly execution_receipt?: {
          readonly compile_input?: {
            readonly view?: { readonly cap_contracts?: readonly unknown[] };
          };
        };
      };
      expect(result.execution_receipt?.compile_input?.view?.cap_contracts).toEqual([cap]);
    } finally {
      database.close();
      closeCachedDatabase(database.filename);
      removeTempDirectorySync(directory);
    }
  });

  it("admits omitted mixed v1 capabilities and rejects explicit supports_source_evidence=false before worker execute", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-undeclared-mixed-"));
    const database = initDatabase({ filename: join(directory, "alaya.db") });
    prepareIndexedRecallProjection(database);
    try {
      const { protocol_version: _protocol, supported_result_kinds: _kinds,
        supports_source_evidence: _source, supports_product_updates: _updates,
        ...plainMixed } = conditionalRecallPayload("needle");
      await expect(runOperation(createQueryOnlyRuntime(database), {
        protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION,
        id: 1,
        operation: "conditionalField.recall",
        payload: encodeWorkerRecallPayload(plainMixed)
      })).resolves.toMatchObject({ index: expect.objectContaining({ query_id: expect.any(String) }) });
      await expect(runOperation(createQueryOnlyRuntime(database), {
        protocol_version: RECALL_READ_WORKER_PROTOCOL_VERSION,
        id: 2,
        operation: "conditionalField.recall",
        payload: encodeWorkerRecallPayload({ ...plainMixed, supports_source_evidence: false })
      })).rejects.toThrow(RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE);
    } finally {
      database.close();
      closeCachedDatabase(database.filename);
      removeTempDirectorySync(directory);
    }
  });

  it("passes normalized evidence_conditions from query_coordinates to withPreparedExecution", async () => {
    assertBuiltWorker();
    const directory = mkdtempSync(join(tmpdir(), "alaya-recall-worker-coords-prep-"));
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    prepareIndexedRecallProjection(database);
    database.close();
    closeCachedDatabase(databasePath);
    const prepareSourceQuery = vi.fn(async () => ({
      receipt: unavailableSourceQueryPreparation("test_stub"),
      vector: { status: "unavailable" as const, reason: "test_stub" }
    }));
    const client = createRecallReadWorkerClient({
      databaseFilename: databasePath,
      workerUrl: builtWorkerUrl,
      workerCount: 1,
      prepareSourceQuery
    });
    try {
      expect(client).not.toBeNull();
      if (client === null) return;
      const { createDependencies } = await import("../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js");
      const { runProductionBoundRecall } = await import("../../../mcp-memory/recall/recall-bound-service.js");
      const { buildRecallPolicy } = await import("@do-soul/alaya-core");
      const recallService = new RecallService({
        ...createDependencies().dependencies,
        now: () => "2026-09-08T00:00:00.000Z",
        readSnapshot: client.readSnapshot,
        conditionalFieldPort: client.conditionalFieldPort,
        activeConstraintsPort: client.activeConstraintsPort
      });
      const request = SoulMemorySearchRequestSchema.parse({
        query: "Which café did Alice visit last week?",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 5,
        query_coordinates: {
          question_time: { intervals: [{ start: "2026-09-01", end: "2026-09-07" }] },
          evidence_conditions: [
            { statement: "Alice visited <café>.", speaker: "user", anchors: ["Alice"] },
            { statement: "Bob visited <café>.", speaker: "user", anchors: ["Bob"] }
          ]
        }
      });
      const taskSurfaceId = randomUUID();
      const policyOverride = buildRecallPolicy({
        runtimeId: randomUUID(),
        taskSurfaceId,
        maxResults: 5,
        filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
        conflictAwareness: true,
        maxTotalTokens: 2000
      });
      await runProductionBoundRecall({
        deps: { recallService } as unknown as Parameters<typeof runProductionBoundRecall>[0]["deps"],
        request,
        context: { workspaceId: "ws-prep", runId: null, agentTarget: "codex", sessionId: "s-prep" },
        taskSurface: TaskObjectSurfaceSchema.parse({
          runtime_id: policyOverride.task_surface_ref,
          object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
          task_surface_ref: null,
          expires_at: null,
          derived_from: null,
          retention_policy: RetentionPolicy.SESSION_ONLY,
          surface_kind: "mcp_memory_tool",
          display_name: request.query,
          context_refs: []
        }),
        policyOverride,
        now: () => "2026-09-08T00:00:00.000Z"
      });
      expect(prepareSourceQuery).toHaveBeenCalledWith(expect.objectContaining({
        workspace_id: "ws-prep",
        navigation: request.query,
        evidence_statements: ["Alice visited <café>."]
      }));
    } finally {
      await client?.close();
      removeTempDirectorySync(directory);
    }
  }, 30_000);
});

async function collectWorkerResponses(
  worker: Worker,
  requests: readonly unknown[]
): Promise<Array<{ readonly id: number; readonly ok: boolean; readonly result?: unknown }>> {
  const responses: Array<{ readonly id: number; readonly ok: boolean; readonly result?: unknown }> = [];
  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("worker responses did not arrive in time")),
      10_000
    );
    const handler = (message: unknown) => {
      const parsed = message as { readonly id: number; readonly ok: boolean; readonly result?: unknown };
      responses.push(parsed);
      if (responses.length >= requests.length) {
        clearTimeout(timeout);
        worker.off("message", handler);
        resolve();
      }
    };
    worker.on("message", handler);
    for (const request of requests) {
      worker.postMessage(request);
    }
  });
  await done;
  return responses;
}


const timeoutEnvName = "ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS";
const originalTimeoutEnv = process.env[timeoutEnvName];

describe("recall read worker request timeout", () => {
  afterEach(() => {
    if (originalTimeoutEnv === undefined) delete process.env[timeoutEnvName];
    else process.env[timeoutEnvName] = originalTimeoutEnv;
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an explicit Node timer delay outside the supported integer range: %s",
    (value) => {
      expect(() => normalizeRequestTimeoutMs(value)).toThrow(
        "recall read worker request timeout must be a safe integer between 1 and 2147483647"
      );
    }
  );

  it("rejects an invalid configured environment delay instead of silently using the default", () => {
    process.env[timeoutEnvName] = "0.5";
    expect(() => normalizeRequestTimeoutMs(undefined)).toThrow(
      "recall read worker request timeout must be a safe integer between 1 and 2147483647"
    );
  });

  it("uses the default only when neither an explicit nor environment delay is configured", () => {
    delete process.env[timeoutEnvName];
    expect(normalizeRequestTimeoutMs(undefined)).toBe(30_000);
  });
});

it("lets cancellation win only before the atomic issuance claim", () => {
  const early = new AbortController();
  const cancelled = createDeliverySettlement(early.signal);
  early.abort();
  expect(claimDeliverySettlement(cancelled.buffer)).toBe(false);
  cancelled.dispose();
  const late = new AbortController();
  const issuing = createDeliverySettlement(late.signal);
  expect(claimDeliverySettlement(issuing.buffer)).toBe(true);
  late.abort();
  finishDeliverySettlement(issuing.buffer, true);
  expect(() => claimDeliverySettlement(issuing.buffer)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  issuing.dispose();
});

it.each([true, false])("refuses a consumed arbitration claim as a domain conflict after committed=%s", committed => {
  const settlement = createDeliverySettlement();
  expect(claimDeliverySettlement(settlement.buffer)).toBe(true);
  expect(() => claimDeliverySettlement(settlement.buffer)).toThrow(CoreError);
  finishDeliverySettlement(settlement.buffer, committed);
  expect(() => claimDeliverySettlement(settlement.buffer)).toThrow(expect.objectContaining({ code: "CONFLICT",
    message: "Recall acknowledgment arbitration already consumed" }));
  settlement.dispose();
});

const preparedIndex = { entries: [] } as unknown as InformationIndex;

describe("worker recall delivery acknowledgment", () => {
  it("settles from the stored index without parsing an acknowledge index payload", () => {
    const runtime = {} as RecallReadWorkerRuntime;
    const issue = vi.fn();
    const receipt = { schema_version: 1 as const };
    const preparationId = prepareWorkerDelivery(runtime, {
      index: preparedIndex,
      execution_receipt: receipt,
      issue
    } as never, {});
    const parse = vi.spyOn(InformationIndexSchema, "parse");
    const settled = acknowledgeWorkerDelivery(runtime, {
      preparation_id: preparationId,
      issued_entry_ids: [],
      previews: {}
    });
    expect(settled).toBe(receipt);
    expect(issue).toHaveBeenCalledWith({ index: preparedIndex, previews: new Map(), metadata: {} });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("releases the prepared field charge once the delivery is acknowledged", () => {
    const runtime = {} as RecallReadWorkerRuntime;
    const before = recallExecutionRetention.snapshot().retained_bytes;
    const preparationId = prepareWorkerDelivery(runtime, {
      index: preparedIndex, execution_receipt: { schema_version: 1 as const }, issue: vi.fn(),
      execution_id: "released-on-settle", retained_bytes: 4_000_000
    } as never, {});
    expect(recallExecutionRetention.snapshot().retained_bytes - before).toBeGreaterThan(4_000_000);
    acknowledgeWorkerDelivery(runtime, { preparation_id: preparationId, issued_entry_ids: [], previews: {} });
    expect(recallExecutionRetention.snapshot().retained_bytes - before).toBeLessThan(10_000);
    recallExecutionRetention.invalidate("released-on-settle");
  });

  it("releases the prepared field on discard without issuing", () => {
    const runtime = {} as RecallReadWorkerRuntime;
    const issue = vi.fn();
    const before = recallExecutionRetention.snapshot().retained_bytes;
    const preparationId = prepareWorkerDelivery(runtime, {
      index: preparedIndex, execution_receipt: { schema_version: 1 as const }, issue,
      execution_id: "released-on-discard", retained_bytes: 4_000_000
    } as never, {});
    expect(discardWorkerDelivery(runtime, preparationId)).toBeNull();
    expect(issue).not.toHaveBeenCalled();
    expect(recallExecutionRetention.snapshot().retained_bytes - before).toBe(0);
    expect(() => acknowledgeWorkerDelivery(runtime, {
      preparation_id: preparationId, issued_entry_ids: [], previews: {}
    })).toThrow(/expired or discarded/);
    expect(discardWorkerDelivery(runtime, "unknown-preparation")).toBeNull();
    recallExecutionRetention.invalidate("released-on-discard");
  });

  it("refuses ACK and discard from a different runtime without issuing, then the owner can still settle", () => {
    const owner = {} as RecallReadWorkerRuntime;
    const stranger = {} as RecallReadWorkerRuntime;
    const issue = vi.fn();
    const receipt = { schema_version: 1 as const };
    const preparationId = prepareWorkerDelivery(owner, {
      index: preparedIndex, execution_receipt: receipt, issue, execution_id: "foreign-runtime-settle"
    } as never, {});
    const foreignAck = () => acknowledgeWorkerDelivery(stranger, {
      preparation_id: preparationId, issued_entry_ids: [], previews: {}
    });
    const foreignDiscard = () => discardWorkerDelivery(stranger, preparationId);
    for (const run of [foreignAck, foreignDiscard]) {
      try {
        run();
        expect.fail("expected CONFLICT");
      } catch (error) {
        expect(error).toBeInstanceOf(CoreError);
        expect((error as CoreError).code).toBe("CONFLICT");
        expect((error as Error).message).toMatch(/belongs to another runtime/);
      }
    }
    expect(issue).not.toHaveBeenCalled();
    expect(acknowledgeWorkerDelivery(owner, {
      preparation_id: preparationId, issued_entry_ids: [], previews: {}
    })).toBe(receipt);
    expect(issue).toHaveBeenCalledOnce();
    recallExecutionRetention.invalidate("foreign-runtime-settle");
  });
});

const PROPOSAL_DIGEST = `sha256:${"a".repeat(64)}`;
const PROPOSAL_NOW = "2026-09-10T00:00:00.000Z";

describe("worker proposal structural budget", () => {
  it("rejects the same oversize and deep proposal programs as MCP", () => {
    const deep = nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH + 1);
    const wide = bushyProgram(QUERY_PROPOSAL_MAX_AST_NODES + 1);
    expect(ConditionalFieldRecallWorkerPayloadSchema.safeParse(proposalPayload(deep)).success).toBe(false);
    expect(ConditionalFieldRecallWorkerPayloadSchema.safeParse(proposalPayload(wide)).success).toBe(false);
    expect(ConditionalFieldRecallWorkerPayloadSchema.safeParse(
      proposalPayload(nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH))
    ).success).toBe(true);
  });
});

function proposalPayload(program: unknown) {
  return {
    workspace_id: "ws",
    query_text: "needle",
    budget: {
      schema_version: 1 as const,
      work_units: 10_000,
      memory_bytes: 1_000_000,
      page_budget: 800,
      finalization_reserve: 100,
      min_envelope: 10
    },
    snapshot_id: PROPOSAL_DIGEST,
    interpretation_clock: PROPOSAL_NOW,
    as_of: PROPOSAL_NOW,
    expires_at: "2027-01-01T00:00:00.000Z",
    lifetime_now: PROPOSAL_NOW,
    protocol_version: 1 as const,
    supports_source_evidence: true,
    supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    authorized_scopes: { mode: "unrestricted" as const },
    interpretation_proposal: {
      schema_version: 1,
      original_query_digest: PROPOSAL_DIGEST,
      producer_id: "compiler.ordinary.v1",
      program
    }
  };
}

function nestedClosures(depth: number): unknown {
  let node: unknown = { schema_version: 1, kind: "epsilon" };
  for (let index = 1; index < depth; index += 1) {
    node = {
      schema_version: 1,
      kind: "closure",
      product_state_sufficient: true,
      body: node
    };
  }
  return node;
}

function bushyProgram(nodes: number): unknown {
  if (nodes <= 1) return { schema_version: 1, kind: "epsilon" };
  const fanout = Math.min(1000, nodes - 1);
  const base = Math.floor((nodes - 1) / fanout);
  const extra = (nodes - 1) % fanout;
  const steps: unknown[] = [];
  for (let index = 0; index < fanout; index += 1) {
    steps.push(bushyProgram(base + (index < extra ? 1 : 0)));
  }
  return { schema_version: 1, kind: "sequence", steps };
}
