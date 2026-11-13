import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { runConditionalFieldRecall } from "../../../recall/runtime/recall-service-runner.js";
import { recallExecutionRetention } from "../../../recall/runtime/recall-execution-retention.js";
import { CoreError } from "../../../shared/errors.js";
import { readersFor } from "../conditional-field-oracle/bound-producer.js";
import { defaultBudget, FAR_FUTURE_EXPIRY, INTERPRETATION_CLOCK, SNAPSHOT_ID }
  from "../conditional-field/reference/deployment.fixture.js";
import { WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
const fillers: string[] = [];
afterEach(() => {
  for (const execution of fillers.splice(0)) recallExecutionRetention.invalidate(execution);
  for (const database of databases) database.close();
  databases.clear();
});

it("resuming a continuation after LRU eviction returns invalidated coverage instead of a new ranked page", async () => {
  const slice = await openSourceSlice(database => databases.add(database));
  for (let index = 0; index < 5; index += 1) {
    await slice.writeMemory(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
      "deployment checklist", MemoryDimension.FACT);
  }
  const request = {
    workspace_id: WS, query_text: "deployment checklist",
    budget: defaultBudget({ page_budget: 1 }), snapshot_id: SNAPSHOT_ID,
    interpretation_clock: INTERPRETATION_CLOCK, as_of: INTERPRETATION_CLOCK,
    expires_at: FAR_FUTURE_EXPIRY, result_kind_view: "memory_only" as const,
    readers: readersFor(slice), authorized_scopes: null
  };
  const first = runConditionalFieldRecall(request);
  const continuation = first.continuation;
  expect(continuation).not.toBeNull();
  expect(first.entries.length).toBeGreaterThan(0);
  expect(first.completeness.observed_coverage).not.toBe("invalidated");
  const handleA = continuation!.continuation_id;
  const executionA = recallExecutionRetention.executionFor(handleA);
  expect(executionA).toBeDefined();
  const workspace = recallExecutionRetention.workspaceFor(executionA!);
  expect(workspace).toBe(WS);

  const removed = vi.fn();
  const unsubscribe = recallExecutionRetention.subscribe(removed);
  fillers.push(retainFillerWithoutEvicting(workspace, handleA));
  expect(recallExecutionRetention.executionFor(handleA)).toBe(executionA);

  const later = runConditionalFieldRecall(request);
  expect(later.continuation).not.toBeNull();
  const laterExecution = recallExecutionRetention.executionFor(later.continuation!.continuation_id);
  if (laterExecution !== undefined) fillers.push(laterExecution);
  expect(removed.mock.calls.some(call =>
    call[0].reason === "evicted" && call[0].handles.includes(handleA))).toBe(true);
  expect(recallExecutionRetention.executionFor(handleA)).toBeUndefined();
  unsubscribe();

  const resumed = runConditionalFieldRecall({ ...request, continuation });
  expect(resumed.completeness.observed_coverage).toBe("invalidated");
  expect(resumed.completeness.logical_index).toBe("invalidated");
  expect(resumed.continuation).toBeNull();
  expect(resumed.entries).toEqual([]);
});

// The singleton's capacity is fixed, so the filler takes the largest size that still keeps the protected execution.
function retainFillerWithoutEvicting(workspace: string, protectHandle: string): string {
  const execution = `fill-${randomUUID()}`;
  const key = `field:${execution}`;
  const handle = `h-${execution}`;
  const row = (bytes: number) => ({ execution, workspace, bytes, handles: [handle], value: {} });
  let lo = 0;
  let hi = 256 * 1024 * 1024;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let dropped = false;
    let refused = false;
    try {
      recallExecutionRetention.transaction(() => {
        recallExecutionRetention.set(key, row(mid));
        dropped = recallExecutionRetention.executionFor(protectHandle) === undefined;
        throw new Error("rollback-fill-probe");
      });
    } catch (error) {
      if (error instanceof CoreError && error.details?.resource === "execution_retention") refused = true;
      else if (!(error instanceof Error) || error.message !== "rollback-fill-probe") throw error;
    }
    if (refused || dropped) hi = mid - 1;
    else { best = mid; lo = mid + 1; }
  }
  if (best > 0) recallExecutionRetention.set(key, row(best));
  return execution;
}
