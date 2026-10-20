import { expect, it } from "vitest";
import { encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { EXISTING_TEST_WORK_UNITS, fixtureSources, recallRequest } from "./source-semantic-library-binding-coverage.js";

it("charges the empty library trace to the parent after real SQLite worker selection is absorbed", async () => {
  await withAccessLibrary(fixtureSources(), async ({ execute, filename, ids }) => {
    const request = recallRequest(ids, EXISTING_TEST_WORK_UNITS);
    expect(request.budget.work_units).toBe(200_000);
    const ordinary = await accessCall(execute, request);
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
    try {
      await client.ready();
      const observed = await client.observeSourceSemantics({}, () => accessCall(client.sourceSemanticsPort!.execute, request));
      if (observed.outcome.status !== "success") throw observed.outcome.error;
      const result = observed.outcome.value;
      expect(result.index.entries).toEqual([]);
      expect(result.previews).toEqual(ordinary.previews);
      expect(result.discovery.access).toEqual(ordinary.discovery.access);
      expect(result.work.logical_work).toBe(ordinary.work.logical_work);
      expect(result.work.logical_work).toBeLessThanOrEqual(200_000);
      expect(result.coverage.payload === "truncated" || result.discovery.truncated).toBe(true);
      const access = result.discovery.access;
      expect(access).toBeDefined();
      expect(access!.trace).toEqual({ kind: "library_selection",
        omitted_source_count: access!.observed_source_count - access!.source_candidates.length,
        omitted_interpretation_count: access!.observed_interpretation_count - access!.interpretation_candidates.length });
      expect(access!.interpretation_candidates.map(row => row.interpretation_id).sort())
        .toEqual([...result.discovery.examined_source_interpretation_ids].sort());
      const encoded = encodeSourceSemanticLibraryResponse(result);
      if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("complete empty library page expected");
      expect(encoded.results).toEqual([]);
      expect(encoded.discovery?.access).toEqual(access);
      expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(request.output_byte_limit);

      const observation = observed.observations[0]!;
      expect(observed.observations).toHaveLength(1);
      expect(observation.execution).toBe("success");
      const parent = observation.meters.find(row => row.parent === null)!;
      const selection = observation.meters.find(row => row.phase === "selection")!;
      expect(selection.parent).toBe(parent.id);
      expect(observation.meters.filter(row => row.parent === null)).toHaveLength(1);
      expect(selection.spent.work_units).toBeGreaterThan(0);
      expect(selection.held).toEqual({ work_units: 0, memory_bytes: 0 });
      const cost = (reason: string, operation: string) => observation.costs.find(row =>
        row.phase === "request" && row.reason === reason && row.operation === operation);
      expect(cost("selection", "absorb")).toMatchObject({ count: 1,
        work: selection.spent.work_units, bytes: selection.spent.memory_bytes });
      expect(cost("access trace selection", "debit")).toMatchObject({ count: 1,
        work: access!.observed_source_count + access!.observed_interpretation_count });
      expect(cost("access trace delivery", "debit")?.work).toBeGreaterThan(0);
      expect(cost("access trace delivery", "debit")?.bytes).toBeGreaterThan(0);
      // These operations each occur once; aggregate insertion order is execution order.
      expect(observation.costs.indexOf(cost("selection", "absorb")!))
        .toBeLessThan(observation.costs.indexOf(cost("access trace selection", "debit")!));
      expect(parent.spent.work_units).toBe(result.work.logical_work);
      expect(parent.spent.memory_bytes).toBe(result.work.logical_memory_bytes);
      expect(observation.totals?.debit_work).toBe(result.work.logical_work);
      expect(observation.totals?.debit_bytes).toBe(result.work.logical_memory_bytes);
    } finally { await client.close(); }
  });
}, 120_000);
