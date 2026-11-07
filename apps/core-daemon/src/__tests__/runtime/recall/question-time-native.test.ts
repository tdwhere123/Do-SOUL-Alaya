import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { installProviderFreeBoundary } from "../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js";
import type { QueryInterpretationProposal } from "@do-soul/alaya-protocol";

const boundary = installProviderFreeBoundary();
const { prepareIndexedRecallProjection } = await import("@do-soul/alaya-storage");
const { runConditionalFieldRecallWithReceipt, snapshotIdFromPin } = await import("@do-soul/alaya-core");
const { QUESTION_TIME_PROPOSAL_PRODUCER_ID } = await import("@do-soul/alaya-protocol");
const { fixture, configuration, WORKSPACE } = await import("../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js");
const { publishIndex, queryInput } = await import("../../../../../../packages/core/src/__tests__/source-index/source-index-acquisition-fixture.js");
const { createConditionalFieldObserverReaders, nominateNativeSources } = await import("../../../runtime/recall-read-worker/observer-operations.js");
const { SourceSemanticObserver } = await import("../../../runtime/recall-read-worker/source-semantic-observation.js");
const opened: ReturnType<typeof fixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const env of opened.splice(0)) env.database.close(); });
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
const clock = "2026-09-07T00:00:00.000Z";
const proposal: QueryInterpretationProposal = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: `sha256:${createHash("sha256").update("needle").digest("hex")}`, question_time: { interpretation_clock: clock,
    intervals: [{ start: "2020-01-02", end: "2020-01-02" }] } };

function setup() {
  const env = fixture(":memory:"); opened.push(env);
  prepareIndexedRecallProjection(env.database);
  const { config, records } = publishIndex(env, [
    { id: "old", body: "needle a", vectors: [[1, 0, 0]], eventTime: "2020-01-01T00:00:00.000Z" },
    { id: "preferred", body: "needle a", vectors: [[0, 1, 0]], eventTime: "2020-01-02T23:59:59.999Z" },
    { id: "unknown", body: "needle a", vectors: [[0, 0, 1]], eventTime: null }
  ], configuration());
  const vector = queryInput(config).vector;
  const readers = createConditionalFieldObserverReaders(env.database, [], vector);
  const request = { workspace_id: WORKSPACE, query_text: "needle", readers,
    snapshot_id: snapshotIdFromPin(WORKSPACE, readers.snapshotPin!(WORKSPACE)),
    budget: { schema_version: 1 as const, work_units: 100_000, memory_bytes: 4_000_000,
      page_budget: 4, finalization_reserve: 512, min_envelope: 10 },
    interpretation_clock: clock, as_of: clock, expires_at: "2099-01-01T00:00:00.000Z", authorized_scopes: ["project"],
    enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const,
    protocol_version: 1 as const, supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    supports_source_evidence: true, supports_product_updates: true };
  return { env, records, vector, request };
}

describe("question-time native ordinary boundary", () => {
  it("carries the admitted proposal through compilation, native SQLite and first delivery", () => {
    const { env, request, records } = setup();
    const capture = vi.fn(request.readers.nominateSources!);
    const result = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt({ ...request,
      readers: { ...request.readers, nominateSources: capture }, interpretation_proposal: proposal }))();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0].questionTime).toEqual(proposal.question_time);
    const id = records.find(record => record.source_id === "preferred")!.record_id;
    expect(result.index.entries[0]?.target).toMatchObject({ root_id: id });
    expect(result.index.entries).toHaveLength(3);
    expect(result.execution_receipt.actual?.phases.acquire?.native_bytes).toBeGreaterThan(0);
    expect(capture.mock.results[0]!.value.result.accounting.attempted).toBeLessThanOrEqual(128);
  });

  it("does not turn preference into a hard filter or override public since/until", () => {
    const { env, request, records } = setup();
    const nominate = vi.fn(request.readers.nominateSources!);
    const result = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt({ ...request,
      readers: { ...request.readers, nominateSources: nominate },
      interpretation_proposal: proposal, since: "2020-01-01T00:00:00.000Z", until: "2020-01-01T23:59:59.999Z" }))();
    expect(result.index.entries.map(entry => entry.target.kind === "source_evidence" ? entry.target.root_id : null))
      .toEqual([records.find(record => record.source_id === "old")!.record_id]);
    expect(nominate.mock.calls[0]![0].taskObservationBlock).toBe("source_guard");
  });

  it("reports source-bound eligibility separately from the unfiltered prefix without a task proposal", () => {
    const { env, vector } = setup();
    const observer = new SourceSemanticObserver(3, { max_events: 512, max_bytes: 262144 });
    env.database.connection.transaction(() => nominateNativeSources(env.database, {
      workspaceId: WORKSPACE, query: "needle", authorizedScopes: ["project"], sourceId: "old",
      questionTime: proposal.question_time!, budget: { work_units: 0, memory_bytes: 0 }
    }, vector, observer))();
    const fact = observer.finish("success").events.find(event => event.kind === "source_index_acquisition"
      && (event.data as { kind?: string }).kind === "source_task_inventory")?.data;
    expect(fact).toMatchObject({ state: "active", context: { block: null, source_id: "old" },
      original: expect.arrayContaining([expect.objectContaining({ source_id: "preferred" })]),
      eligible: [expect.objectContaining({ source_id: "old" })] });
  });

  it("preserves native fallback after failed time SQL and keeps zero request resources bounded", () => {
    const { env, vector } = setup();
    const input = { workspaceId: WORKSPACE, query: "needle", authorizedScopes: ["project"],
      questionTime: proposal.question_time!, budget: { work_units: 0, memory_bytes: 0 } };
    const query = (funding: "allowance" | "request", observer?: InstanceType<typeof SourceSemanticObserver>) =>
      env.database.connection.transaction(() => nominateNativeSources(env.database, input, vector, observer, funding))();
    const refusedObserver = new SourceSemanticObserver(1, { max_events: 512, max_bytes: 262144 });
    const refused = query("request", refusedObserver);
    expect(refused.result?.nominations).toEqual([]);
    expect(refused.result?.completion).not.toBe("complete");
    expect(refused.result?.resources).toMatchObject({ work: 0, memory_bytes: 0 });
    expect(refusedObserver.finish("success").events.some(event => event.kind === "source_index_acquisition"
      && (event.data as { kind?: string }).kind === "source_task_inventory")).toBe(false);
    env.database.connection.exec("ALTER TABLE evidence_capsules RENAME COLUMN retained_source_event_time TO missing_event_time");
    const failedObserver = new SourceSemanticObserver(2, { max_events: 512, max_bytes: 262144 });
    const failed = query("allowance", failedObserver);
    expect(failed.result?.nominations).toHaveLength(3);
    expect(failed.result?.completion).toBe("partial");
    expect(failed.result?.resource_refusals).toContainEqual({ stage: "nomination", phase: "question_time_read_failed" });
    const inventory = failedObserver.finish("success").events.find(event => event.kind === "source_index_acquisition"
      && (event.data as { kind?: string }).kind === "source_task_inventory");
    expect(inventory?.data).toMatchObject({ state: "unavailable", coverage: "partial", reason: "question_time_read_failed",
      original: expect.arrayContaining([expect.objectContaining({ target: expect.objectContaining({ kind: "source_evidence" }) })]) });
    expect(inventory?.data).not.toHaveProperty("eligible");
  });
});
