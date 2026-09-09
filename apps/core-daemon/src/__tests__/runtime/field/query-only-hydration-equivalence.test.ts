import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import {
  EVIDENCE_ID,
  MEMORY_ID,
  WORKSPACE_ID,
} from "./source-field-harness.js";
import {
  DORMANT_ID,
  INDEX_ONLY_ID,
  JSON_ONLY_ID,
  LIVE_B_ID,
  MISSING_ID,
  TOMBSTONE_ID,
  createQueryOnlyHydrationHarness,
  dispatchQueryOnly,
  conditionalRecallPayload,
  createQueryOnlyRuntime,
  persistConditionalSource
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

    const evidenceObjectIds = Object.freeze([EVIDENCE_ID, MISSING_ID]);
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

  it("preserves actual source-backed index through query-only worker dispatch", async () => {
    const fixture = await hydration.openHydrationFixture();
    const objectId = "88888888-8888-4888-8888-888888888888";
    await persistConditionalSource(fixture.writer, objectId, "nebulapivot published source");
    const payload = conditionalRecallPayload("nebulapivot");
    const direct = await dispatchQueryOnly(createQueryOnlyRuntime(fixture.writer),
      "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    const dispatched = await dispatchQueryOnly(fixture.queryOnlyRuntime,
      "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(dispatched.index).toEqual(direct.index);
    expect(dispatched.previews).toEqual(direct.previews);
    expect(dispatched.index.entries.map((entry) => entry.object_id)).toEqual([objectId]);
    expect(dispatched.previews[objectId]).toContain("nebulapivot");
    expect(fixture.queryOnly.connection.pragma("query_only", { simple: true })).toBe(1);
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
