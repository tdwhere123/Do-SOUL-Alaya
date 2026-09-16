import { describe, expect, it, vi } from "vitest";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../../mcp-memory/tool/tool-handler.js";
import { createSoulResolveHandler } from "../../../mcp-memory/tool/resolve-handler.js";
import {
  capableRecallRequest,
  context,
  createDeliveryRecord,
  createDeps,
  createRecallCandidate,
  stubRecallIndex
} from "./mcp-memory-tool-handler-fixture.js";

const HANDLER_TIMEOUT = {
  error_code: "handler_timeout",
  message: "MCP tool execution timed out.",
  error_type: "TimeoutError"
} as const;

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createStartedGate<T>(work: (release: () => void) => Promise<T>): {
  readonly started: Promise<void>;
  readonly run: () => Promise<T>;
} {
  const started = Promise.withResolvers<void>();
  return {
    started: started.promise,
    run: async () => await work(() => started.resolve())
  };
}

describe("mcp memory tool abort after in-tool awaits", () => {
  it("does not record recall delivery after abort during recall", async () => {
    const deps = createDeps();
    const abort = new AbortController();
    const hang = createStartedGate(async (release) => {
      release();
      await waitForAbort(abort.signal);
      return {
        candidates: [createRecallCandidate()],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 1,
        coarse_filter_count: 0,
        fine_assessment_count: 0,
        degradation_reason: null,
        working_projection: null,
        provider_calls: 0,
        garden_enqueue: 0,
        index: stubRecallIndex(["mem1"])
      };
    });
    deps.recallService.recall = vi.fn(hang.run) as typeof deps.recallService.recall;
    const handler = createMcpMemoryToolHandler(deps);
    const pending = handler.call({
      toolName: "soul.recall",
      arguments: capableRecallRequest({
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      }),
      context: { ...context, abortSignal: abort.signal }
    });
    await hang.started;
    abort.abort(HANDLER_TIMEOUT);

    await expect(pending).rejects.toEqual(HANDLER_TIMEOUT);
    expect(deps.trustStateRecorder.recordDelivery).not.toHaveBeenCalled();
  });

  it("does not record usage proof after abort during delivery lookup", async () => {
    const deps = createDeps();
    const abort = new AbortController();
    const hang = createStartedGate(async (release) => {
      release();
      await waitForAbort(abort.signal);
      return createDeliveryRecord("delivery_1");
    });
    deps.trustStateRecorder.findDeliveryById = vi.fn(hang.run);
    const handler = createMcpMemoryToolHandler(deps);
    const pending = handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          {
            object_id: "mem1",
            object_kind: "memory_entry",
            usage_status: "used"
          }
        ]
      },
      context: { ...context, abortSignal: abort.signal }
    });
    await hang.started;
    abort.abort(HANDLER_TIMEOUT);

    await expect(pending).rejects.toEqual(HANDLER_TIMEOUT);
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
  });

  it("does not resolve after abort during delivery lookup", async () => {
    const deps = createDeps();
    const abort = new AbortController();
    const resolve = vi.fn();
    const hang = createStartedGate(async (release) => {
      release();
      await waitForAbort(abort.signal);
      return createDeliveryRecord("delivery_1");
    });
    const handler = createMcpMemoryToolHandler({
      ...deps,
      soulResolveHandler: createSoulResolveHandler({
        resolutionService: { resolve },
        trustStateRecorder: {
          findDeliveryById: hang.run
        }
      })
    } as McpMemoryToolHandlerDependencies);
    const pending = handler.call({
      toolName: "soul.resolve",
      arguments: {
        target_object_id: "mem1",
        resolution: "reject",
        delivery_id: "delivery_1"
      },
      context: { ...context, abortSignal: abort.signal }
    });
    await hang.started;
    abort.abort(HANDLER_TIMEOUT);

    await expect(pending).rejects.toEqual(HANDLER_TIMEOUT);
    expect(resolve).not.toHaveBeenCalled();
  });
});
