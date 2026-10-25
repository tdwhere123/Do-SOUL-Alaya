import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError, MemoryService, snapshotIdFromPin, captureIndexPreviews, captureIndexSourceMetadata, encodeIndexResults,
  runConditionalFieldRecallWithReceipt, type ConditionalFieldExecutionReceipt,
  type ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import { PUBLIC_ERROR_CODE_MESSAGES } from "@do-soul/alaya-protocol";
import { initDatabase, closeCachedDatabase, prepareIndexedRecallProjection, SqliteMemoryEntryRepo,
  SqliteEvidenceCapsuleRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { RecallReadWorkerLifecycle } from "../../../runtime/recall/recall-read-worker-lifecycle.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { context, createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { conditionalRecallPayload, encodeWorkerRecallPayload } from "../field/query-only-hydration-fixture.js";
import { assertBuiltWorker, createEvidenceCapsule } from "./recall-read-worker-client-fixture.js";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import type { RecallPageFitObservation } from "../../../../../../packages/core/src/recall/runtime/recall-page-fit.js";

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";
const CONTENT = "needle authored private source body";
const BYTE_CAP = 1_000_000;
const restricted = { max_total_tokens: 1, max_encoded_bytes: BYTE_CAP };
const permitted = { max_total_tokens: 2_000, max_encoded_bytes: BYTE_CAP };

function assertOmission(error: unknown) {
  expect(error).toBeInstanceOf(CoreError);
  if (!(error instanceof CoreError)) throw new Error("expected Core refusal");
  expect(error.code).toBe("CONFLICT");
  expect(error.subCode).toBeUndefined();
  expect(error.details).toMatchObject({ outcome: "resource_exhausted", resource: "encoded_members",
    reason: "encoded_member_omission", page_fit: { measurement: "complete", expected_result_count: 1,
      representation_page_budget: 1, max_total_tokens: 1, max_encoded_bytes: BYTE_CAP, byte_overflow: false,
      encoding: { candidate_count: 1, result_count: 0, count_limited_entries: 0, used_tokens: 0,
        metadata_block: { remaining_tokens: 1 } } } });
  const fit = error.details!.page_fit as RecallPageFitObservation;
  expect(fit.encoding!.metadata_block!.essential_bytes).toBeGreaterThan(1);
  expect(fit.measured_bytes).toBeGreaterThan(0);
  expect(fit.measured_bytes).toBeLessThan(BYTE_CAP);
  expect(fit.spent_work).toBeGreaterThan(0);
  const receipt = error.details!.execution_receipt as ConditionalFieldExecutionReceipt;
  expect(receipt.actual!.phases.observe.native_visits).toBeGreaterThan(0);
  expect(receipt.actual!.phases.index.budget_work).toBeGreaterThanOrEqual(fit.spent_work);
  expect(receipt.actual!.native_visits).toBeGreaterThan(0);
  expect(receipt.actual!.native_bytes).toBeGreaterThan(0);
  expect(error.details).not.toHaveProperty("required_bytes");
  expect(error.details).not.toHaveProperty("index");
  expect(error.details).not.toHaveProperty("results");
  expect(error.details).not.toHaveProperty("delivery_id");
  expect(JSON.stringify(error.details)).not.toContain(CONTENT);
  expect(JSON.stringify(error.details)).not.toContain(EVIDENCE_ID);
  return error;
}

it("retains a below-byte-cap metadata refusal through direct Core, worker IPC and sanitized ordinary MCP", async () => {
  assertBuiltWorker();
  const directory = mkdtempSync(join(tmpdir(), "alaya-page-fit-refusal-"));
  const filename = join(directory, "native.db");
  const database = initDatabase({ filename });
  const warn = vi.fn<(message: string, meta: Record<string, unknown>) => void>();
  const unavailable = vi.fn();
  let lifecycle: RecallReadWorkerLifecycle | undefined;
  try {
    const base = conditionalRecallPayload("needle");
    const request = { ...base, budget: { ...base.budget, page_budget: 1 },
      result_kind_view: "memory_only" as const, delivery_budget: restricted };
    const evidence = new SqliteEvidenceCapsuleRepo(database);
    await evidence.create(createEvidenceCapsule({ object_id: EVIDENCE_ID, workspace_id: request.workspace_id,
      run_id: "run-1", artifact_ref: "authored-evidence" }));
    const memories = new MemoryService({ memoryEntryRepo: new SqliteMemoryEntryRepo(database),
      eventLogRepo: new SqliteEventLogRepo(database), now: () => request.as_of, generateObjectId: () => MEMORY_ID,
      evidenceService: { findById: id => evidence.findById(id), findByIds: (workspace, ids) => evidence.findByIds(workspace, ids) },
      runtimeNotifier: { notifyEntry: async () => {} } });
    await memories.create({ created_by: "user_action", dimension: "fact", source_kind: "user",
      formation_kind: "explicit", scope_class: "project", content: CONTENT, domain_tags: [], evidence_refs: [EVIDENCE_ID],
      workspace_id: request.workspace_id, run_id: "run-1", surface_id: null });
    prepareIndexedRecallProjection(database);
    const readers = createConditionalFieldObserverReaders(database);
    request.snapshot_id = snapshotIdFromPin(request.workspace_id, readers.snapshotPin!(request.workspace_id));
    let directError: unknown;
    try { runConditionalFieldRecallWithReceipt({ ...request, readers }); }
    catch (error) { directError = error; }
    assertOmission(directError);
    // The member and its essential metadata still exist; refusal does not issue an
    // empty success, drop the metadata, or consume the member for a later request.
    const success = runConditionalFieldRecallWithReceipt({ ...request, readers, delivery_budget: permitted });
    expect(success.index.entries.map(entry => entry.object_id)).toEqual([MEMORY_ID]);
    const rows = encodeIndexResults(success.index, captureIndexPreviews(success.index, readers, request.workspace_id),
      permitted.max_total_tokens, captureIndexSourceMetadata(success.index));
    expect(rows.map(row => row.object_id)).toEqual([MEMORY_ID]);
    expect(rows[0]!.evidence_pointers).toEqual([EVIDENCE_ID]);
    database.close(); closeCachedDatabase(filename);

    lifecycle = new RecallReadWorkerLifecycle({ databaseFilename: filename,
      workerUrl: new URL("./provider-free-recall-read-worker-fixture.mjs", import.meta.url),
      workerCount: 1, requestTimeoutMs: 10_000, warn, onUnavailable: unavailable });
    const workerLifecycle = lifecycle;
    await workerLifecycle.isolate(async () => {
      await workerLifecycle.readSnapshot.beginDeferred();
      const failure = await workerLifecycle.request("conditionalField.recall", encodeWorkerRecallPayload(request))
        .then(() => undefined, error => error);
      const error = assertOmission(failure);
      expect(error.details!.worker).toMatchObject({ rss_sampling_method: "process.memoryUsage().rss" });
      const worker = error.details!.worker as { native_visits: number; bytes_read: number };
      expect(worker.native_visits).toBeGreaterThan(0);
      expect(worker.bytes_read).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({ operation: "conditionalField.recall", failure: {
        core_details_status: "present", truncated_fields: [],
        error: { core: { code: "CONFLICT", details: error.details } }
      } });
      await workerLifecycle.readSnapshot.rollback();
      await expect(workerLifecycle.request("ready", {})).resolves.toBeNull();
      const recovered = await workerLifecycle.request<ConditionalFieldRecallPortResult>("conditionalField.recall",
        encodeWorkerRecallPayload({ ...request, delivery_budget: permitted }));
      expect(recovered.index.entries.map(entry => entry.object_id)).toEqual([MEMORY_ID]);
      expect(recovered.preparation_id).toBeDefined();
    });

    // Exercise the real ordinary tool error boundary on another actual worker
    // rejection, not a manufactured public result or a changed code mapping.
    const deps = createDeps();
    deps.recallService.recall = () => workerLifecycle.request<never>("conditionalField.recall", encodeWorkerRecallPayload(request));
    const response = await createMcpMemoryToolHandler(deps).call({ toolName: "soul.recall", context, arguments: {
      query: "needle", max_results: 1, scope_class: null, dimension: null, domain_tags: null,
      protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"],
      supports_source_evidence: true, supports_product_updates: true
    } });
    expect(response).toEqual({ ok: false, tool_name: "soul.recall",
      error: { code: "INTERNAL", message: PUBLIC_ERROR_CODE_MESSAGES.INTERNAL } });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(unavailable).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CONTENT);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(EVIDENCE_ID);
  } finally {
    await lifecycle?.close();
    if (!database.isClosed()) database.close();
    closeCachedDatabase(filename);
    removeTempDirectorySync(directory);
  }
}, 20_000);
