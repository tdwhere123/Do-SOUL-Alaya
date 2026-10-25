import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError } from "@do-soul/alaya-core";
import { PUBLIC_ERROR_CODE_MESSAGES } from "@do-soul/alaya-protocol";
import { initDatabase, closeCachedDatabase, prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { context, createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { conditionalRecallPayload, encodeWorkerRecallPayload } from "../field/query-only-hydration-fixture.js";
import { RecallReadWorkerLifecycle } from "../../../runtime/recall/recall-read-worker-lifecycle.js";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { classifyError, sanitizeError } from "../../../mcp-memory/tool/tool-handler-support.js";
import { createWarnLogger } from "../../../runtime/daemon/lifecycle/daemon-runtime-helpers.js";

type Warn = (message: string, meta: Record<string, unknown>) => void;
const fixtureUrl = new URL("./recall-read-rejection-worker-fixture.mjs", import.meta.url);
async function harness(warn: Warn, production = false) {
  const directory = mkdtempSync(join(tmpdir(), "alaya-worker-failure-"));
  const filename = join(directory, "native.db");
  if (production) {
    const database = initDatabase({ filename });
    prepareIndexedRecallProjection(database);
    database.close(); closeCachedDatabase(filename);
  }
  const unavailable = vi.fn();
  const lifecycle = new RecallReadWorkerLifecycle({ databaseFilename: filename,
    workerUrl: production ? new URL("./provider-free-recall-read-worker-fixture.mjs", import.meta.url) : fixtureUrl,
    workerCount: 1, requestTimeoutMs: 10_000, warn, onUnavailable: unavailable });
  return { lifecycle, unavailable, cleanup: async () => {
    await lifecycle.close(); removeTempDirectorySync(directory);
  } };
}

async function rejectedError(request: Promise<unknown>): Promise<Error & { details?: Readonly<Record<string, unknown>> }> {
  const error: unknown = await request.then(() => undefined, error => error);
  if (!(error instanceof Error)) throw new Error("expected a worker Error rejection");
  return error;
}

// These authored errors verify preservation, not the unavailable historic exception.
describe("accepted worker rejection private evidence", () => {
  it.each(["core", "ordinary"])("keeps %s classification, measured evidence and correlation across rollback", async kind => {
    const warn = vi.fn<Warn>();
    const h = await harness(warn);
    try {
      await h.lifecycle.isolate(async () => {
        const worker = h.lifecycle.pinnedWorker()!;
        await h.lifecycle.request("ready", {});
        await h.lifecycle.readSnapshot.beginDeferred();
        const error = await rejectedError(h.lifecycle.request("conditionalField.recall", { kind }));
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof CoreError).toBe(kind === "core");
        expect(error.name).toBe(kind === "core" ? "CoreError" : "TypeError");
        expect(error.message).toBe("private worker refusal");
        expect(error.details).toMatchObject({ owner: { label: "private-owner-evidence" },
          worker: { rss_sampling_method: "process.memoryUsage().rss" } });
        const measured = error.details?.worker as { rss_bytes: number };
        expect(measured.rss_bytes).toBeGreaterThan(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]).toEqual(["recall read worker request failed", expect.objectContaining({
          worker_thread_id: worker.threadId, request_id: 3, operation: "conditionalField.recall",
          failure: expect.objectContaining({ error: expect.objectContaining({ name: error.name,
            message: error.message, stack: error.stack }) })
        })]);
        const record = warn.mock.calls[0]![1];
        const failure = record.failure as { error: { core?: { code: string; subCode: string; details: unknown }; details?: unknown } };
        if (kind === "core") expect(failure.error.core).toEqual({ code: "CONFLICT", subCode: "CONCURRENT_MODIFICATION", details: error.details });
        else { expect(failure.error.core).toBeUndefined(); expect(failure.error.details).toEqual(error.details); }
        expect(classifyError(error)).toBe("INTERNAL");
        expect(sanitizeError(error)).not.toContain("private");
        await h.lifecycle.readSnapshot.rollback();
        await expect(h.lifecycle.request("memory.findByWorkspaceId", {})).resolves.toEqual([]);
        expect(h.lifecycle.isAvailable(worker)).toBe(true);
        expect(h.unavailable).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![1]).toBe(record);
        worker.emit("message", { id: 3, ok: false, error: { name: "Error", message: "duplicate" } });
        worker.emit("message", { id: 999, ok: false, error: { name: "Error", message: "unmatched" } });
        expect(warn).toHaveBeenCalledTimes(1);
      });
    } finally { await h.cleanup(); }
  });

  it.each(["core", "ordinary"])("keeps the full public MCP %s failure sanitized", async kind => {
    const warn = vi.fn<Warn>();
    const h = await harness(warn);
    try {
      const deps = createDeps();
      deps.recallService.recall = () => h.lifecycle.request<never>("conditionalField.recall", { kind,
        query_text: "query-body-must-not-be-logged" });
      const handler = createMcpMemoryToolHandler(deps);
      const result = await handler.call({ toolName: "soul.recall", context, arguments: {
        query: "needle", max_results: 5, scope_class: null, dimension: null, domain_tags: null,
        protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"],
        supports_source_evidence: true, supports_product_updates: true
      } });
      expect(result).toEqual({ ok: false, tool_name: "soul.recall",
        error: { code: "INTERNAL", message: PUBLIC_ERROR_CODE_MESSAGES.INTERNAL } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("query-body-must-not-be-logged");
    } finally { await h.cleanup(); }
  });

  it.each(["throw", "mutate", "async throw"])("isolates a sink that does %s from rejection, rollback and close", async mode => {
    const sink = vi.fn<Warn>((_message, meta) => {
      const failure = meta.failure as { error: { message: string; core: { details: { owner: { label: string } } } } };
      failure.error.message = "sink changed message";
      failure.error.core.details.owner.label = "sink changed details";
      if (mode === "throw") throw new Error("diagnostic sink unavailable");
      if (mode === "async throw") return Promise.reject(new Error("async diagnostic sink unavailable"));
    });
    const h = await harness(sink);
    try {
      await h.lifecycle.isolate(async () => {
        const worker = h.lifecycle.pinnedWorker()!;
        await h.lifecycle.readSnapshot.beginDeferred();
        const error = await rejectedError(h.lifecycle.request("conditionalField.recall", { kind: "core" }));
        expect(error).toBeInstanceOf(CoreError);
        expect(error).toMatchObject({ message: "private worker refusal", code: "CONFLICT",
          subCode: "CONCURRENT_MODIFICATION", details: { owner: { label: "private-owner-evidence" } } });
        await h.lifecycle.readSnapshot.rollback();
        await expect(h.lifecycle.request("ready", {})).resolves.toBeNull();
        expect(h.lifecycle.isAvailable(worker)).toBe(true);
        expect(sink).toHaveBeenCalledTimes(1);
        expect(h.unavailable).not.toHaveBeenCalled();
      });
    } finally { await h.cleanup(); }
  });

  it.each([["absent", "absent"], ["large", "omitted_oversize"],
    ["unserializable", "omitted_unserializable"], ["shared", "omitted_unserializable"],
    ["circular", "omitted_unserializable"]])("marks %s details without rewriting the rejected error", async (kind, status) => {
    const warn = vi.fn<Warn>();
    const h = await harness(warn);
    try {
      const error = await rejectedError(h.lifecycle.request("conditionalField.recall", { kind }));
      expect(warn).toHaveBeenCalledExactlyOnceWith("recall read worker request failed", expect.objectContaining({
        failure: expect.objectContaining({ details_status: status, core_details_status: "absent", truncated_fields: [] })
      }));
      const failure = warn.mock.calls[0]![1].failure as { error: { details?: unknown } };
      expect(failure.error.details).toBeUndefined();
      if (kind === "large") expect(error.details?.large).toHaveLength(100_000);
      if (kind === "unserializable") expect(error.details?.value).toBe(1n);
      if (kind === "shared") expect(error.details?.shared).toBeInstanceOf(SharedArrayBuffer);
      if (kind === "circular") expect(error.details?.self).toBeDefined();
      if (kind === "absent") expect(error.details).toBeUndefined();
      await expect(h.lifecycle.request("ready", {})).resolves.toBeNull();
    } finally { await h.cleanup(); }
  });

  it("bounds long diagnostic text and marks truncation without changing the rejection", async () => {
    const warn = vi.fn<Warn>();
    const h = await harness(warn);
    try {
      const error = await rejectedError(h.lifecycle.request("conditionalField.recall", { kind: "long-text" }));
      const failure = warn.mock.calls[0]![1].failure as { error: { message: string; stack: string }; truncated_fields: string[] };
      expect(error.message).toHaveLength(130_000);
      expect(failure.error.message).toHaveLength(8_192);
      expect(failure.error.stack).toHaveLength(8_192);
      expect(failure.truncated_fields).toEqual(["message", "stack"]);
    } finally { await h.cleanup(); }
  });

  it("captures actual production dispatch rejections and permits the same worker's rollback and next read", async () => {
    const warn = vi.fn<Warn>();
    const h = await harness(warn, true);
    try {
      await h.lifecycle.isolate(async () => {
        const worker = h.lifecycle.pinnedWorker()!;
        await h.lifecycle.request("ready", {});
        await h.lifecycle.readSnapshot.beginDeferred();
        const payload = encodeWorkerRecallPayload({ ...conditionalRecallPayload("needle"), budget: {
          schema_version: 1, work_units: 1, memory_bytes: 1_000_000, page_budget: 1, finalization_reserve: 0, min_envelope: 1
        } });
        const core = await rejectedError(h.lifecycle.request("conditionalField.recall", payload));
        if (!(core instanceof CoreError)) throw new Error("expected production CoreError");
        expect(core.details).toMatchObject({ outcome: "resource_exhausted", worker: { rss_sampling_method: "process.memoryUsage().rss" } });
        const nonCore = await rejectedError(h.lifecycle.request("conditionalField.recall", {}));
        expect(nonCore).toBeInstanceOf(Error);
        expect(nonCore).not.toBeInstanceOf(CoreError);
        expect(nonCore.name).toBe("ZodError");
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls.map(([, record]) => [record.worker_thread_id, record.request_id, record.operation]))
          .toEqual([[worker.threadId, 3, "conditionalField.recall"], [worker.threadId, 4, "conditionalField.recall"]]);
        expect(warn.mock.calls[0]![1].failure).toMatchObject({ error: { core: { code: core.code, details: core.details } } });
        expect(warn.mock.calls[1]![1].failure).toMatchObject({ error: { name: "ZodError", message: nonCore.message, stack: nonCore.stack },
          details_status: "absent", core_details_status: "absent" });
        await h.lifecycle.readSnapshot.rollback();
        await expect(h.lifecycle.request("memory.findByWorkspaceId", { workspaceId: "workspace-1", tier: "hot", page: { limit: 1, offset: 0 } }))
          .resolves.toEqual([]);
        expect(h.lifecycle.isAvailable(worker)).toBe(true);
        expect(h.unavailable).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(2);
      });
    } finally { await h.cleanup(); }
  });

  it("emits the structured private record through the real stderr logger, not stdout", async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
      lines.push(String(chunk)); return true;
    });
    const stdout = vi.spyOn(process.stdout, "write");
    const h = await harness(createWarnLogger().warn);
    try {
      await expect(h.lifecycle.request("conditionalField.recall", { kind: "ordinary" })).rejects.toThrow("private worker refusal");
      const records = lines.flatMap(line => line.trim().split("\n")).map(line => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ msg: "recall read worker request failed", request_id: 1,
        operation: "conditionalField.recall", failure: { error: { name: "TypeError", message: "private worker refusal",
          details: { owner: { label: "private-owner-evidence", token: "[Redacted]" }, worker: { rss_sampling_method: "process.memoryUsage().rss" } } } } });
      expect(lines.join("")).not.toContain("fixture-sensitive-token");
      expect(stdout).not.toHaveBeenCalled();
    } finally { await h.cleanup(); stderr.mockRestore(); stdout.mockRestore(); }
  });
});
