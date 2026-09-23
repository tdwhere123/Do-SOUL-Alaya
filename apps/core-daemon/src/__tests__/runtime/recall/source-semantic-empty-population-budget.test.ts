import { expect, it } from "vitest";
import { SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { createSourceSemanticAccessPolicy } from "@do-soul/alaya-core";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { reserveEmptyInterpretationCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { ACCESS_BUDGET, CLOCK, WS, withAccessLibrary } from "./source-semantic-access.test-support.js";

it("subtracts already-spent observation work once at the exact completion boundary", async () => {
  await withAccessLibrary([], async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const runtime = { database } as RecallReadWorkerRuntime;
    const policy = createSourceSemanticAccessPolicy("orchid irrigation", undefined, "query-conditioned-v1",
      new SourceSemanticReadBudget(ACCESS_BUDGET));
    const attempt = (allowance: { work_units: number; memory_bytes: number }) => {
      const parent = new SourceSemanticReadBudget(allowance);
      const child = new SourceSemanticReadBudget({ work_units: 1_000, memory_bytes: 1_000 });
      child.charge(107, 229, "already observed header");
      let error: unknown;
      try {
        reserveEmptyInterpretationCompletion({ runtime, parent, child, records: [], sourcePages: 1,
          policy: "query-conditioned-v1", budget: ACCESS_BUDGET,
          orderCost: policy.orderCost,
          leaseContext: { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
            expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: "orchid irrigation" } });
      } catch (caught) { error = caught; }
      finally { parent.absorb(child); }
      return { parent, child, error };
    };
    try {
      const ampleBudget = { work_units: 1_000_000, memory_bytes: 1_000_000 };
      const ample = attempt(ampleBudget);
      expect(ample.error).toBeUndefined();
      const workReserve = ample.parent.work - ample.child.work;
      const byteReserve = ample.parent.bytes - ample.child.bytes;
      const exactBudget = { work_units: ample.parent.spentWork + workReserve,
        memory_bytes: ample.parent.spentBytes + byteReserve };
      const exact = attempt(exactBudget);
      expect(exact.error).toBeUndefined();
      expect(exact.child.work).toBe(0);
      expect(exact.child.bytes).toBe(0);
      expect(exact.parent.spentWork).toBeLessThanOrEqual(exactBudget.work_units);
      expect(exact.parent.spentBytes).toBeLessThanOrEqual(exactBudget.memory_bytes);
      for (const short of [{ ...exactBudget, work_units: exactBudget.work_units - 1 },
        { ...exactBudget, memory_bytes: exactBudget.memory_bytes - 1 }]) {
        const rejected = attempt(short);
        expect(rejected.error).toBeInstanceOf(SourceSemanticResourceExhausted);
        expect(rejected.parent.spentWork).toBeLessThanOrEqual(short.work_units);
        expect(rejected.parent.spentBytes).toBeLessThanOrEqual(short.memory_bytes);
        expect(rejected.parent.spentWork).toBeGreaterThan(107);
      }
    } finally { database.close(); closeCachedDatabase(filename); }
  });
});
