import { describe, expect, it, vi } from "vitest";
import { EvidenceService, type ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import { SqliteEvidenceCapsuleRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { EVIDENCE_ID, MEMORY_ID, WORKSPACE_ID, composeField, plantRevoke, produceAdaSource } from "./source-field-harness.js";
import { conditionalRecallPayload, createQueryOnlyHydrationHarness, dispatchQueryOnly,
  persistConditionalSource } from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("native source publication and conditional Recall", () => {
  it("observes committed source publication across a query-only connection and reopen", async () => {
    const pair = hydration.openQueryOnlyPair();
    const payload = conditionalRecallPayload("nebulapivot");
    const empty = await dispatchQueryOnly(pair.queryOnlyRuntime, "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(empty.index.entries).toEqual([]);
    expect(empty.index.completeness.observed_coverage).toBe("exhausted_empty");
    await persistConditionalSource(pair.writer, MEMORY_ID, "nebulapivot native source");
    const published = await dispatchQueryOnly(pair.queryOnlyRuntime, "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(published.index.entries.map((entry) => entry.object_id)).toEqual([MEMORY_ID]);
    expect(published.previews[MEMORY_ID]).toContain("nebulapivot");
    const filename = pair.writer.filename;
    pair.queryOnly.connection.close();
    hydration.planted.close(pair.writer);
    const reopened = hydration.openQueryOnlyPair(filename, false);
    const replay = await dispatchQueryOnly(reopened.queryOnlyRuntime, "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(replay.index).toEqual(published.index);
    expect(replay.previews).toEqual(published.previews);
    expect(reopened.writer.connection.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("keeps source evidence health history effective at its declared as-of", async () => {
    const pair = hydration.openQueryOnlyPair();
    const field = composeField(pair.writer);
    await produceAdaSource(pair.writer, field.stores, "ada");
    const evidenceService = new EvidenceService({
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(pair.writer),
      eventLogRepo: new SqliteEventLogRepo(pair.writer),
      runtimeNotifier: { notifyEntry: vi.fn() },
      now: () => "2026-08-16T00:01:00.000Z", projectionLifecycle: field.projectionLifecycle
    });
    await evidenceService.transitionHealth(EVIDENCE_ID, "broken", "test_transition", "system");
    const before = field.projectionLifecycle.rebuild(WORKSPACE_ID, "2026-08-16T00:00:30.000Z");
    const after = field.projectionLifecycle.rebuild(WORKSPACE_ID, "2026-08-16T00:02:00.000Z");
    expect(after.governance_frontier).not.toBe(before.governance_frontier);
    expect(after.input_event_frontier).toBe(before.input_event_frontier);
    expect(field.fieldRepos.generations.readArtifacts(WORKSPACE_ID, after.generation_id)).toBeNull();
  });

  it("keeps the source revocation ledger temporal without an ordinary Recall selector", async () => {
    const pair = hydration.openQueryOnlyPair();
    const field = composeField(pair.writer);
    await produceAdaSource(pair.writer, field.stores, "ada");
    plantRevoke(field, EVIDENCE_ID, "2026-08-16T00:01:00.000Z");
    const before = field.projectionLifecycle.rebuild(WORKSPACE_ID, "2026-08-16T00:00:30.000Z");
    const after = field.projectionLifecycle.rebuild(WORKSPACE_ID, "2026-08-16T00:02:00.000Z");
    expect(after.governance_frontier).not.toBe(before.governance_frontier);
    expect(after.input_event_frontier).toBe(before.input_event_frontier);
    expect(field.fieldRepos.generations.readArtifacts(WORKSPACE_ID, after.generation_id)).toBeNull();
  });
});
