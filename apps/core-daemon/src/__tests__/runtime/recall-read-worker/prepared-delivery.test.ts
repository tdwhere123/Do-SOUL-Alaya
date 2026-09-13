import { describe, expect, it, vi } from "vitest";
import { InformationIndexSchema, type InformationIndex } from "@do-soul/alaya-protocol";
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
});
