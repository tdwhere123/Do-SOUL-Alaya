import { describe, expect, it, vi } from "vitest";
import { InformationIndexSchema, type InformationIndex } from "@do-soul/alaya-protocol";
import { recallExecutionRetention } from "@do-soul/alaya-core";
import {
  prepareWorkerDelivery,
  settleWorkerDelivery
} from "../../../runtime/recall-read-worker/prepared-delivery.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";

const index = { entries: [] } as unknown as InformationIndex;

describe("worker recall delivery acknowledgment", () => {
  it("settles from the stored index without parsing an acknowledge index payload", () => {
    const runtime = {} as RecallReadWorkerRuntime;
    const issue = vi.fn();
    const receipt = { schema_version: 1 as const };
    const preparationId = prepareWorkerDelivery(runtime, {
      index,
      execution_receipt: receipt,
      issue
    } as never, {});
    const parse = vi.spyOn(InformationIndexSchema, "parse");
    const settled = settleWorkerDelivery(runtime, {
      preparation_id: preparationId,
      issued_entry_ids: [],
      previews: {}
    }, false);
    expect(settled).toBe(receipt);
    expect(issue).toHaveBeenCalledWith({ index, previews: new Map(), metadata: {} });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("releases the prepared field charge once the delivery is acknowledged", () => {
    const runtime = {} as RecallReadWorkerRuntime;
    const before = recallExecutionRetention.snapshot().retained_bytes;
    const preparationId = prepareWorkerDelivery(runtime, {
      index, execution_receipt: { schema_version: 1 as const }, issue: vi.fn(),
      execution_id: "released-on-settle", retained_bytes: 4_000_000
    } as never, {});
    expect(recallExecutionRetention.snapshot().retained_bytes - before).toBeGreaterThan(4_000_000);
    settleWorkerDelivery(runtime, { preparation_id: preparationId, issued_entry_ids: [], previews: {} }, false);
    expect(recallExecutionRetention.snapshot().retained_bytes - before).toBeLessThan(10_000);
    recallExecutionRetention.invalidate("released-on-settle");
  });
});
