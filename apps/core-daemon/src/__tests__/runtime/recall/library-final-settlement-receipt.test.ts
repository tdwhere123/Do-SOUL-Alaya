import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { Worker } from "node:worker_threads";
import { indexEntryCacheKey, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { mcpFromWorker } from "../../../mcp-memory/tool/interpretation-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { CLOCK, QUERY_BUDGET, SCOPES, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

it.each([512, 0])("preserves final acknowledgment separately from fitted preparation with an event cap of %s", async max_events => {
  await withIndexedSources([{ id: "needle", text: "needle source", vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient(), port = client.sourceSemanticsPort!;
    const post = Worker.prototype.postMessage;
    const acknowledgments: { id: number; ok: boolean; result: unknown }[] = [];
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message, ...args) {
      if (message.operation === "conditionalField.acknowledge") {
        const listener = (reply: { id: number; ok: boolean; result: unknown }) => {
          if (reply.id === message.id) { acknowledgments.push(reply); this.off("message", listener); }
        };
        this.on("message", listener);
      }
      return post.call(this, message, ...args);
    });
    let prepared: SourceSemanticWorkerResult | undefined, returned: unknown;
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: {
      ...port, execute: async input => { prepared = await port.execute(input); return prepared; },
      acknowledge: async (...args) => { const receipt = await port.acknowledge!(...args); returned = receipt; return receipt; }
    } });
    const observed = await client.observeSourceSemantics({ max_events }, () => handler.call({ toolName: "soul.interpretation",
      arguments: { operation: "recall", accepts_unreviewed_conditional_results: true, original_query: "needle",
        semantic_correspondences: [], authorized_scopes: SCOPES, budget: QUERY_BUDGET, output_byte_limit: 176340 },
      context: { workspaceId: WS, runId: "run", sessionId: "session", agentTarget: "bench-runner" } }));
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const result = observed.outcome.value;
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if (prepared?.kind !== "recall" || prepared.protocol_version !== 11 || prepared.preparation_id === undefined) {
      throw new Error("prepared library field page expected");
    }
    const ack = acknowledgments[0]!;
    expect(ack.ok).toBe(true);
    expect(returned).toEqual(ack.result);
    const final = ack.result as { worker: { native_visits: number }; actual: { native_visits: number } };
    const preparation = prepared.field_execution_receipt as unknown as typeof final;
    expect(final.worker.native_visits).toBeGreaterThan(preparation.worker.native_visits);
    expect(final.actual.native_visits).toBeGreaterThan(preparation.actual.native_visits);
    // No physical counter is added to logical work, and no fitted bytes are rewritten.
    expect(result.output).toEqual(mcpFromWorker(prepared));
    const event = observed.observations.flatMap(row => row.events).find(row => row.kind === "delivery_settlement");
    const settlement = observed.observations.find(row => row.request_id === ack.id);
    expect(settlement?.execution).toBe("success");
    if (max_events > 0) {
      expect(event?.data).toEqual({ preparation_id: prepared.preparation_id, execution_receipt: ack.result });
      expect(settlement?.status).toBe("observed");
    } else {
      expect(event).toBeUndefined();
      expect(settlement?.status).toBe("overflow");
      expect(settlement?.dropped_events).toBe(1);
    }
    const page = prepared;
    const retry = await client.observeSourceSemantics({ max_events }, () => port.acknowledge!(page.preparation_id!, page.index,
      new Map(Object.entries(page.previews ?? {}))));
    expect(retry.outcome).toEqual({ status: "success", value: ack.result });
    expect(retry.observations.flatMap(row => row.events).find(row => row.kind === "delivery_settlement")?.data)
      .toEqual(event?.data);
    expect(prepared.index.entries.map(indexEntryCacheKey)).not.toEqual([]);
  });
}, 60000);
