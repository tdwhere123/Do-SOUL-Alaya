import { describe, expect, it } from "vitest";
import { runOperation } from "../../../runtime/recall-read-worker/dispatch.js";
import { isRecallReadWorkerRequest } from
  "../../../runtime/recall-read-worker/protocol-validation.js";
import {
  RECALL_READ_WORKER_OPERATIONS,
  type RecallReadWorkerOperation,
  type RecallReadWorkerRequest
} from "../../../runtime/recall-read-worker/protocol.js";
import { createQueryOnlyHydrationHarness } from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

type PinSelectOperation = Extract<
  RecallReadWorkerOperation,
  `${string}pin${string}` | `${string}select${string}` | "pin" | "select"
>;
const noPinSelectOperation: PinSelectOperation extends never ? true : false = true;

const FORGED_OPERATIONS = ["unknown.op", "pin", "select", "field.pin", "field.select"] as const;
const NON_FINITE_IDS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] as const;

describe("query-only recall-read dispatch validation", () => {
  it("accepts every typed recall-read operation and rejects forged pin/select requests", () => {
    expect(noPinSelectOperation).toBe(true);
    for (const operation of RECALL_READ_WORKER_OPERATIONS) {
      expect(isRecallReadWorkerRequest(typedRequest(operation))).toBe(true);
    }
    for (const operation of FORGED_OPERATIONS) {
      expect(isRecallReadWorkerRequest({
        id: 1,
        operation,
        payload: {}
      })).toBe(false);
    }
    for (const id of NON_FINITE_IDS) {
      expect(isRecallReadWorkerRequest({
        id,
        operation: "ready",
        payload: {}
      })).toBe(false);
    }
  });

  it("rejects a forged operation cast into runOperation", async () => {
    const { queryOnlyRuntime } = hydration.openQueryOnlyPair();
    for (const operation of FORGED_OPERATIONS) {
      await expect(runOperation(queryOnlyRuntime, {
        id: 1,
        operation,
        payload: {}
      } as RecallReadWorkerRequest)).rejects.toThrow();
    }
  });

  it("rejects a closed runtime before in-process tier-window dispatch", async () => {
    const { queryOnlyRuntime } = hydration.openQueryOnlyPair();
    queryOnlyRuntime.closed = true;
    await expect(runOperation(queryOnlyRuntime, {
      id: 1,
      operation: "memory.findRecallTierWindow",
      payload: {}
    })).rejects.toThrow("recall read worker database is closed");
  });
});

function typedRequest(operation: RecallReadWorkerOperation): RecallReadWorkerRequest {
  return { id: 1, operation, payload: {} };
}
