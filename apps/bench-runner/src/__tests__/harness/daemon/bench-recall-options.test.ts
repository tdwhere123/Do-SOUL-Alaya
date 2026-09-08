import { afterEach, describe, expect, it } from "vitest";
import { InformationIndexSchema, type InformationIndex, type RequestBudget } from "@do-soul/alaya-protocol";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { measureConditionalFieldResponse, ConditionalFieldMeasurementSchema } from "../../../runs/measurement/conditional-field-measurement.js";

const handles: BenchDaemonHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.shutdown();
});

const budget: RequestBudget = {
  schema_version: 1, work_units: 10_000, memory_bytes: 1_000_000,
  page_budget: 1, finalization_reserve: 100, min_envelope: 10
};

describe("bench target recall request options", () => {
  it("concatenates bounded pages against uninterrupted recall with one interpretation clock", async () => {
    const daemon = await startBenchDaemon({ embeddingMode: "disabled" });
    handles.push(daemon);
    const ids: string[] = [];
    for (const label of ["alpha", "beta", "gamma"]) {
      const seed = await daemon.proposeMemory(`Needle ${label} reference.`, `evidence-${label}`);
      ids.push(seed.memoryId);
    }
    const interpretationClock = new Date().toISOString();
    const full = await daemon.recall("needle", { budget: { ...budget, page_budget: 20 }, interpretationClock });
    const expected = InformationIndexSchema.parse(full.index);
    expect(expected.entries.map((entry) => entry.object_id).sort()).toEqual(ids.sort());
    const delivered: string[] = [];
    let continuation: InformationIndex["continuation"] = null;
    for (let page = 0; page < 8; page += 1) {
      const result = await daemon.recall("needle", {
        budget, continuation, ...(page === 0 ? { interpretationClock } : {})
      });
      const index = InformationIndexSchema.parse(result.index);
      expect(index.query_id).toBe(expected.query_id);
      expect(index.snapshot_id).toBe(expected.snapshot_id);
      expect(index.interpretation_id).toBe(expected.interpretation_id);
      expect(index.as_of).toBe(interpretationClock);
      expect(result.provider_calls).toBe(0);
      expect(result.garden_enqueue).toBe(0);
      const measurementInput = {
        recallResult: result, queryText: "needle", workspaceId: daemon.workspaceId,
        referenceTime: interpretationClock, requestBudget: budget,
        expectedIndexSnapshotId: expected.snapshot_id,
        deliveredResults: result.results.slice(0, 10).map((row, offset) => ({
          object_id: row.object_id, object_kind: row.object_kind, rank: offset + 1
        }))
      };
      const measured = measureConditionalFieldResponse(measurementInput);
      expect(measured?.status).toBe("validated");
      expect(ConditionalFieldMeasurementSchema.parse(JSON.parse(JSON.stringify(measured)))).toEqual(measured);
      expect(measureConditionalFieldResponse({ ...measurementInput, queryText: "a different question" }))
        .toMatchObject({ status: "invalid", reason: "request_identity_mismatch" });
      delivered.push(...index.entries.map((entry) => entry.object_id));
      continuation = index.continuation;
      if (continuation === null) break;
    }
    expect(delivered).toEqual(expected.entries.map((entry) => entry.object_id));
    expect(continuation).toBeNull();
  });

  it("propagates cancellation and temporal filters without treating them as empty completeness", async () => {
    const daemon = await startBenchDaemon({ embeddingMode: "disabled" });
    handles.push(daemon);
    await daemon.proposeMemory("Needle active reference.", "evidence-temporal");
    const interpretationClock = new Date().toISOString();
    const cancelled = await daemon.recall("needle", { budget, interpretationClock, cancelled: true });
    expect(cancelled.index?.completeness.observed_coverage).toBe("cancelled");
    expect(cancelled.index?.completeness.logical_index).not.toBe("complete");
    const filtered = await daemon.recall("needle", {
      budget, interpretationClock,
      timeFilter: { field: "created_at", since: "2090-01-01T00:00:00.000Z" }
    });
    expect(filtered.index?.entries).toEqual([]);
    expect(filtered.provider_calls).toBe(0);
    await expect(daemon.recall("needle", { budget, maxResults: 2 }))
      .rejects.toThrow(/maxResults conflicts/);
  });
});
