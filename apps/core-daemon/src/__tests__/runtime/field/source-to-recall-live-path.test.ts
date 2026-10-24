import { describe, expect, it, vi } from "vitest";
import { indexEntryCacheKey } from "@do-soul/alaya-protocol";
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
    // No native profile/index or query vector is bound: no rows is not proved absence.
    expect(empty.index.completeness.observed_coverage).toBe("unknown");
    expect(empty.index.completeness.logical_index).toBe("open");
    expect(empty.index.completeness.interpretation_coverage).toBe("open");
    const { source } = await persistConditionalSource(pair.writer, MEMORY_ID, "nebulapivot native source");
    const published = await dispatchQueryOnly(pair.queryOnlyRuntime, "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(published.index.entries.map((entry) => entry.target.kind)).toEqual(["source_evidence", "memory_entry"]);
    expect(published.index.entries.find((entry) => entry.target.kind === "memory_entry")?.object_id).toBe(MEMORY_ID);
    expect(published.previews[MEMORY_ID]).toContain("nebulapivot");
    const delivered = published.index.entries.find((entry) => entry.target.kind === "source_evidence")!;
    expect(delivered).toMatchObject({ target: {
      root_kind: "source_record", root_id: source.identity, source_version: "1",
      content_digest: source.content_digest, evidence_object_id: null,
      span: { content_start: 0, content_complete: true }
    }, navigation: { operator: "source_lexical", view: "original" } });
    expect(delivered.object_id).toBeUndefined();
    expect(published.previews[indexEntryCacheKey(delivered)]).toBe("nebulapivot native source");
    const filename = pair.writer.filename;
    pair.queryOnly.connection.close();
    hydration.planted.close(pair.writer);
    const reopened = hydration.openQueryOnlyPair(filename, false);
    const replay = await dispatchQueryOnly(reopened.queryOnlyRuntime, "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(replay.index.continuation).not.toBeNull();
    expect(published.index.continuation).not.toBeNull();
    expect(replay.index).toEqual({ ...published.index, continuation: {
      ...published.index.continuation,
      continuation_id: replay.index.continuation!.continuation_id,
      capability: replay.index.continuation!.capability
    } });
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
