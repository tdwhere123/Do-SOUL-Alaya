import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, SourceAdmissionRequest } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission } from "../../memory/evidence-create/audited-source-admission.js";
import { createAuditedSourceReplacement } from "../../memory/evidence-create/audited-source-replacement.js";
import { createInMemoryFieldStores, type FieldAtomicOutcome } from "../../memory/evidence-create/field-stores.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { EventPublisherPropagationError } from "../../runtime/event-publisher.js";

const CLOCK = "2026-09-13T00:00:00.000Z";
const LATER = "2026-09-13T00:00:01.000Z";
const context = { workspaceId: "workspace-a" };
const request = (overrides: Partial<SourceAdmissionRequest> = {}): SourceAdmissionRequest => ({
  workspace_id: context.workspaceId, source_id: "message", source_version: "1", content_bytes: "Initial report.",
  evidence_object_id: null, recorded_at: CLOCK, event_time: "2026-01-01T00:00:00Z", valid_from: null, valid_to: null,
  spans: [{ start_offset: 0, end_offset: 7, purpose: "native_structure" }], ...overrides
});
const replacementRequest = (overrides: Partial<SourceAdmissionRequest> = {}) => request({
  source_version: "2", content_bytes: "Revised report.", recorded_at: LATER, ...overrides
});
function fixture() {
  const stores = createInMemoryFieldStores();
  const entries: EventLogEntry[] = [];
  const eventLogRepo = { append(event: Omit<EventLogEntry, "event_id" | "revision" | "created_at">): EventLogEntry {
    const entry = { ...event, event_id: `event-${entries.length}`, revision: entries.length + 1, created_at: CLOCK };
    entries.push(entry);
    return entry;
  } };
  const input = { stores, eventLogRepo, sha256: fieldContractSha256, runtimeNotifier: { notifyEntry: vi.fn() } };
  return { stores, entries, input, admission: createAuditedSourceAdmission(input), writer: createAuditedSourceReplacement(input) };
}

describe("audited predecessor-bound source replacement", () => {
  it("retains immutable predecessor bytes and event time, with receipt before audit before notification", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const notify = vi.fn(() => {
      expect(f.stores.listRecords(context.workspaceId)).toHaveLength(2);
      expect(f.entries).toHaveLength(2);
    });
    const writer = createAuditedSourceReplacement({ ...f.input, runtimeNotifier: { notifyEntry: notify } });
    const result = await writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest() }, context);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("replacement did not complete");
    expect(result.transition.predecessor).toEqual(first.record);
    expect(result.transition.replacement.record.event_time).toBe("2026-01-01T00:00:00Z");
    expect(result.transition.replacement.record.recorded_at).toBe(LATER);
    expect(f.stores.getStoredRecord(context.workspaceId, first.record.identity)).toEqual({ record: first.record, content_bytes: "Initial report." });
    expect(f.stores.listSpans(context.workspaceId)).toHaveLength(2);
    expect(result.audit_entry.payload_json).not.toHaveProperty("predecessor");
    expect(notify).toHaveBeenCalledOnce();
  });

  it.each([
    ["record", { identity: `sha256:${"f".repeat(64)}` }],
    ["version", { source_version: "not-the-version" }],
    ["digest", { content_digest: `sha256:${"e".repeat(64)}` }],
    ["workspace", { workspace_id: "foreign" }],
    ["logical source", { source_id: "another-source" }]
  ] as const)("rejects a mismatched predecessor %s without persistence or audit", async (_label, changed) => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const result = await f.writer.replaceCurrent({ expected_current: { ...first.record, ...changed }, replacement: replacementRequest() }, context);
    expect(result.status).toBe("rejected");
    expect(f.stores.listRecords(context.workspaceId)).toEqual([first.record]);
    expect(f.entries).toHaveLength(1);
  });

  it.each([
    { source_version: "1" }, { recorded_at: CLOCK }, { recorded_at: "2026-09-12T23:59:59Z" },
    { source_id: "independent-report" }, { workspace_id: "foreign" }
  ])("rejects revision, ingestion ordering or lineage violation %j", async changed => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    expect((await f.writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest(changed) }, context)).status).toBe("rejected");
    expect(f.stores.listRecords(context.workspaceId)).toEqual([first.record]);
  });

  it("rolls back all formation on malformed span or prohibited null attribution", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    for (const changed of [{ spans: [{ start_offset: 0, end_offset: 99, purpose: "native_structure" as const }] },
      { attribution_context: null }]) {
      const result = await f.writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest(changed) }, context);
      expect(result.status).toBe("rejected");
      expect(f.stores.listRecords(context.workspaceId)).toEqual([first.record]);
      expect(f.stores.listSpans(context.workspaceId)).toEqual(first.spans);
    }
    expect(f.entries).toHaveLength(1);
  });

  it("captures request and predecessor once before any admission hook can mutate the caller's objects", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const replacement = { ...replacementRequest() };
    let reads = 0;
    const expected = { ...first.record, get source_version() { reads += 1; return "1"; } };
    const writer = createAuditedSourceReplacement({ ...f.input, admitHook() { replacement.source_id = "mutated"; replacement.spans = []; } });
    const result = await writer.replaceCurrent({ expected_current: expected, replacement }, context);
    expect(result.status).toBe("ready");
    expect(reads).toBe(1);
    expect(f.stores.getCurrentRecord(context.workspaceId, "mutated")).toBeNull();
    expect(f.stores.listSpans(context.workspaceId)).toHaveLength(2);
  });

  it("does not certify a legacy delegate exception by rereading a replacement that it committed", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const { runAtomicWithOutcome: _phasePort, ...legacy } = f.stores;
    const writer = createAuditedSourceReplacement({ ...f.input, stores: { ...legacy, runAtomic(work) {
      legacy.runAtomic(work);
      throw new Error("lost completion evidence");
    } } });
    const result = await writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest() }, context);
    expect(result.status).toBe("unknown");
    expect(result).not.toHaveProperty("transition");
    expect(f.stores.getCurrentRecord(context.workspaceId, "message")?.source_version).toBe("2");
    expect(f.entries).toHaveLength(1);
  });

  it("preserves unknown before the callback and does not attempt audit or automatically retry", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const phase = vi.fn(() => ({ status: "unknown" as const, cause: new Error("lost storage result") }));
    const writer = createAuditedSourceReplacement({ ...f.input, stores: { ...f.stores, runAtomicWithOutcome: phase } });
    expect((await writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest() }, context)).status).toBe("unknown");
    expect(phase).toHaveBeenCalledOnce();
    expect(f.stores.listRecords(context.workspaceId)).toEqual([first.record]);
    expect(f.entries).toHaveLength(1);
  });

  it.each(["ready", "deferred"] as const)("retains a %s projection outcome and historical transition when superseded during audit", async projection => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    let release!: () => void;
    const stores = { ...f.stores, runAtomicWithOutcome<T>(work: () => T): FieldAtomicOutcome<T> {
      const outcome = f.stores.runAtomicWithOutcome!(work);
      return outcome.status === "committed" ? { status: "committed", result: outcome.result, projection } : outcome;
    } };
    const writer = createAuditedSourceReplacement({ ...f.input, stores, eventLogRepo: { append: event => new Promise<EventLogEntry>(resolve => {
      const entry = f.input.eventLogRepo.append(event);
      release = () => resolve(entry);
    }) } });
    const pending = writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest() }, context);
    const third = await f.admission.admit(replacementRequest({ source_version: "3", recorded_at: "2026-09-13T00:00:02Z" }), context);
    release();
    const result = await pending;
    expect(result.status).toBe(projection === "ready" ? "ready" : "committed_projection_deferred");
    if (result.status !== "ready" && result.status !== "committed_projection_deferred") throw new Error("committed transition required");
    expect(result.transition.predecessor).toEqual(first.record);
    expect(result.transition.replacement.record.source_version).toBe("2");
    expect(result.audit_entry.entity_id).toBe(result.transition.replacement.record.identity);
    expect(f.input.runtimeNotifier.notifyEntry).toHaveBeenCalledTimes(3);
    expect(f.stores.getCurrentRecord(context.workspaceId, "message")).toEqual(third.record);
  });

  it("does not certify an audit append error merely because it resembles a notification failure", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const writer = createAuditedSourceReplacement({ ...f.input, eventLogRepo: { append() {
      throw new EventPublisherPropagationError(f.entries[0]!, new Error("unacknowledged append"));
    } } });
    const result = await writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest() }, context);
    expect(result).toMatchObject({ status: "committed_audit_incomplete", audit: "unknown" });
    expect(result).not.toHaveProperty("audit_entry");
    expect(f.entries).toHaveLength(1);
    expect(f.input.runtimeNotifier.notifyEntry).toHaveBeenCalledOnce();
  });

  it("rejects a nested invocation instead of mistaking a savepoint for a durable transition", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const pending = f.stores.runAtomic(() => f.writer.replaceCurrent({ expected_current: first.record, replacement: replacementRequest() }, context));
    expect((await pending).status).toBe("rejected");
    expect(f.stores.listRecords(context.workspaceId)).toEqual([first.record]);
    expect(f.entries).toHaveLength(1);
  });

  it("ordinary contradictory reports remain separate evidence, not certified replacements", async () => {
    const f = fixture();
    const first = await f.admission.admit(request(), context);
    const report = await f.admission.admit(replacementRequest({ source_id: "independent-report" }), context);
    expect(report).not.toHaveProperty("transition");
    expect(f.stores.getCurrentRecord(context.workspaceId, "message")).toEqual(first.record);
    expect((await f.writer.replaceCurrent({ expected_current: first.record,
      replacement: replacementRequest({ source_id: "independent-report" }) }, context)).status).toBe("rejected");
  });
});
