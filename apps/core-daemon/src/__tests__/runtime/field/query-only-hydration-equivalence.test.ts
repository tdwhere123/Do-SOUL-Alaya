import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import {
  EVIDENCE_ID,
  MEMORY_ID,
  WORKSPACE_ID,
  createPlantedRecall,
  recallRequest
} from "./p217-planted-harness.js";
import {
  DORMANT_ID,
  INDEX_ONLY_ID,
  JSON_ONLY_ID,
  LIVE_B_ID,
  MISSING_ID,
  OMITTED_MEMORY_IDS,
  TOMBSTONE_ID,
  createQueryOnlyHydrationHarness,
  dispatchQueryOnly,
  fieldRecallContract,
  selectAdaEvidenceIds
} from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("query-only field hydration equivalence", () => {
  it("reads committed hydration rows through a second query-only connection", async () => {
    const fixture = await hydration.openHydrationFixture();
    expect(fixture.queryOnly.filename).toBe(fixture.writer.filename);
    expect(fixture.queryOnly.connection).not.toBe(fixture.writer.connection);
    expect(() => fixture.queryOnly.connection.prepare(`
      UPDATE workspaces SET name = ? WHERE workspace_id = ?
    `).run("query-only write probe", WORKSPACE_ID)).toThrow(/readonly|query.?only|attempt to write/iu);

    const selectedIds = selectAdaEvidenceIds(fixture.field.querySession);
    expect(selectedIds).toEqual([EVIDENCE_ID]);
    const evidenceObjectIds = Object.freeze([...selectedIds, MISSING_ID]);
    const direct = await fixture.directRepo.findByEvidenceRefs(WORKSPACE_ID, evidenceObjectIds);
    const dispatched = await dispatchQueryOnly(fixture.queryOnlyRuntime, "memory.findByEvidenceRefs", {
      workspaceId: WORKSPACE_ID,
      evidenceObjectIds
    }) as readonly MemoryEntry[];

    expect(dispatched).toEqual(direct);
    expect(direct.map((entry) => entry.object_id)).toEqual([
      MEMORY_ID,
      LIVE_B_ID,
      INDEX_ONLY_ID
    ]);
    expect(direct.map((entry) => entry.object_id)).not.toContain(MISSING_ID);
    for (const omittedId of [TOMBSTONE_ID, JSON_ONLY_ID, DORMANT_ID]) {
      expect(direct.map((entry) => entry.object_id)).not.toContain(omittedId);
    }
  });

  it("preserves unsorted field membership, source, admission, and receipts", async () => {
    const fixture = await hydration.openHydrationFixture();
    const directRecall = await createPlantedRecall({
      database: fixture.writer,
      field: fixture.field,
      memoryRepo: fixture.directRepo
    }).recall(recallRequest("Ada"));
    const dispatchedRecall = await createPlantedRecall({
      database: fixture.writer,
      field: fixture.field,
      memoryRepo: fixture.dispatchedMemoryPort
    }).recall(recallRequest("Ada"));

    const directContract = fieldRecallContract(directRecall);
    expect(fieldRecallContract(dispatchedRecall)).toEqual(directContract);
    expect(directContract.candidate_keys).toEqual([EVIDENCE_ID]);
    expect(directContract.field_projection_ids).toEqual([MEMORY_ID, LIVE_B_ID]);
    expect(new Set(directContract.field_projection_ids)).toEqual(new Set([MEMORY_ID, LIVE_B_ID]));
    expect(directContract.receipts?.[EVIDENCE_ID]?.length).toBeGreaterThan(0);
    for (const omittedId of OMITTED_MEMORY_IDS) {
      expect(directContract.field_projection_ids).not.toContain(omittedId);
    }
    expect(directRecall.diagnostics?.field_projection_trace?.activation).toMatchObject({
      generation_id: expect.any(String),
      opened_candidate_keys: expect.arrayContaining([EVIDENCE_ID])
    });
  });

  it("reads a recall tier window through in-process runOperation", async () => {
    const fixture = await hydration.openHydrationFixture();
    const query = { workspaceId: WORKSPACE_ID, tier: "hot" as const, limit: 32 };
    const direct = await fixture.directRepo.findRecallTierWindow(query);
    const dispatched = await fixture.dispatchedMemoryPort.findRecallTierWindow!(query);
    expect(dispatched).toEqual(direct);
    expect(direct.memories.map((entry) => entry.object_id)).toEqual(
      expect.arrayContaining([MEMORY_ID, LIVE_B_ID, INDEX_ONLY_ID])
    );

    fixture.queryOnlyRuntime.closed = true;
    await expect(fixture.dispatchedMemoryPort.findRecallTierWindow!(query))
      .rejects.toThrow("recall read worker database is closed");
  });
});
