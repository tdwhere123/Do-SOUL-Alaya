import { afterEach, describe, expect, it } from "vitest";
import { EvidenceHealthState, sourceRecallTarget, type Guard, type QueryInterpretation, type IndexEntry } from "@do-soul/alaya-protocol";
import { SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, SqliteSourceRootRecallReader, type StorageDatabase } from "@do-soul/alaya-storage";
import { observeConditionalField, startObserverCursor, toSourceRootObserverRow, type ObserveConditionalFieldInput } from "../../../../recall/conditional-field/observers/observe.js";
import { BoundedIndexPayload } from "../../../../recall/runtime/index-payload.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";
import { fieldSha256, hashedRecord, openFieldDatabase } from "../../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";
import { evaluateFrozenSourcePredicate } from "../../../../recall/conditional-field/query/source-predicates.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

function fixture(body: string) {
  const database = openFieldDatabase();
  databases.add(database);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  const record = records.insert(hashedRecord("workspace-1", body));
  const capsules = new SqliteEvidenceCapsuleRepo(database);
  return { database, records, record, capsules, reader: new SqliteSourceRootRecallReader(records, capsules) };
}

function literal(needle: string): Guard {
  return { schema_version: 1, kind: "query_predicate", verdict: "unresolved", predicate_name: "source.literal.nfc.v1", entity_id: needle };
}

function sourceInput(reader: SqliteSourceRootRecallReader, needles: readonly string[]): ObserveConditionalFieldInput {
  const query: QueryInterpretation = { schema_version: 1, query_id: "source-boundary", snapshot_id: SNAPSHOT_ID,
    status: "resolved", program: { schema_version: 1, kind: "epsilon" },
    view: { ...defaultView(), result_kind_view: "source_only" }, holes: [], hypotheses: [], source_guard: literal(needles[0]!),
    interpretation_proposal: { schema_version: 1, original_query_digest: SNAPSHOT_ID, producer_id: "source-test",
      conditions: needles.slice(1).map(literal) } };
  return { workspace_id: "workspace-1", query, action: { schema_version: 1, action: "seed", region_id: "seed", work_limit: 16 },
    lease: { schema_version: 1, lease_id: "source-test", status: "active", snapshot_id: SNAPSHOT_ID, query_id: query.query_id },
    cursor: startObserverCursor({ cursor_id: "seed", region_id: "seed", snapshot_id: SNAPSHOT_ID, query_id: query.query_id }),
    source_byte_limit: 8, page_limit: 1, authorized_scopes: null,
    readers: { sourceRoots: (input) => { const page = reader.page({ ...input, nativeByteLimit: 65536 }); return { ...page, rows: page.rows.map(toSourceRootObserverRow) }; } } };
}

function anyAdmitted(input: ObserveConditionalFieldInput): boolean {
  let cursor = input.cursor;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const observed = observeConditionalField({ ...input, cursor });
    if (observed.page.observations.some((row) => row.applicability.verdict === "true")) return true;
    cursor = observed.page.cursor;
    if (observed.page.outcome.status === "exhausted") return false;
  }
  return false;
}

async function capsule(capsules: SqliteEvidenceCapsuleRepo, workspaceId: string, content: string) {
  return capsules.create({ object_id: "99999999-9999-4999-8999-999999999999", object_kind: "evidence_capsule", schema_version: 1,
    lifecycle_state: "active", created_at: "2026-08-16T00:00:00.000Z", updated_at: "2026-08-16T00:00:00.000Z", created_by: "user_action",
    evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "source", keywords: ["source"], summary: "source" },
    event_anchor: null, physical_anchor: null, evidence_health_state: EvidenceHealthState.VERIFIED, gist: "source", excerpt: content,
    source_hash: null, run_id: "run-1", workspace_id: workspaceId, surface_id: null });
}

describe("source boundary regressions", () => {
  it("compares source event times as instants while retaining submillisecond precision", () => {
    const guard: Guard = { schema_version: 1, kind: "query_predicate", verdict: "unresolved",
      predicate_name: "source.event_time.interval.v1", interval: { start: "2026-09-10T00:00:00.000Z",
        end: "2026-09-10T00:00:00.0001Z", time_domain: "source_event_time" } };
    for (const stamp of ["2026-09-10T00:00:00Z", "2026-09-10T00:00:00.0Z", "2026-09-10T00:00:00.00001Z"]) {
      expect(evaluateFrozenSourcePredicate("source.event_time.interval.v1", guard, { event_time: stamp })).toBe("true");
    }
    expect(evaluateFrozenSourcePredicate("source.event_time.interval.v1", guard, { event_time: "2026-09-10T00:00:00.0001Z" })).toBe("false");
    expect(evaluateFrozenSourcePredicate("source.event_time.interval.v1", guard, { event_time: "invalid" })).toBe("unresolved");
  });
  it("recognizes a literal split across bounded chunks", () => {
    const { reader } = fixture("xxxxxxNEEDLExxxxx");
    expect(anyAdmitted(sourceInput(reader, ["NEEDLE"]))).toBe(true);
  });

  it("accumulates distinct literal obligations over one root revision", () => {
    const { reader } = fixture("ALPHAxxxxxxxxxxxxxxxxxxxxxxxxOMEGA");
    expect(anyAdmitted(sourceInput(reader, ["ALPHA", "OMEGA"]))).toBe(true);
  });

  it("normalizes a combining sequence split at a UTF-8 chunk boundary", () => {
    const { reader } = fixture("xxxxxxxe\u0301 target");
    expect(anyAdmitted(sourceInput(reader, ["é target"]))).toBe(true);
  });

  it("does not turn a missing prefix obligation into a known suffix match", () => {
    const { reader } = fixture("ALPHAxxxxxxxxxxxxxxxxxxxxxxxxOMEGA");
    expect(anyAdmitted(sourceInput(reader, ["MISSING", "OMEGA"]))).toBe(false);
  });

  it("preserves both family positions while a record is streamed", async () => {
    const { reader, capsules } = fixture("xxxxxxNEEDLExxxxx");
    await capsule(capsules, "workspace-1", "NEEDLE capsule");
    const input = sourceInput(reader, ["NEEDLE"]);
    const roots = new Set<string>();
    let cursor = input.cursor;
    for (let i = 0; i < 20; i += 1) {
      const result = observeConditionalField({ ...input, cursor });
      for (const row of result.page.observations) if (row.applicability.verdict === "true") roots.add(row.object_id);
      cursor = result.page.cursor;
      if (result.page.outcome.status === "exhausted") break;
    }
    expect(roots.size).toBe(2);
  });

  it("shares one native row allowance across records and capsules", async () => {
    const { reader, capsules } = fixture("record");
    await capsule(capsules, "workspace-1", "capsule");
    const page = reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1, afterCursor: null, byteLimit: 8 });
    expect(page.nativeVisits).toBeLessThanOrEqual(1);
    expect(page.rows.length).toBeLessThanOrEqual(1);
  });

  it("bounds native capsule body bytes before mapping", async () => {
    const { reader, capsules } = fixture("record");
    await capsule(capsules, "workspace-1", "x".repeat(2000));
    const page = reader.page({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1, afterCursor: "c:", byteLimit: 8 });
    expect(page.bytesRead).toBeLessThanOrEqual(11);
  });

  it("rejects a replay that changes retained source role or scope", () => {
    const { records, record } = fixture("same retained source");
    expect(() => records.insert({ ...record, speaker: "assistant", scope_class: "global_core" })).toThrow();
  });

  it("does not admit a cross-workspace capsule alias as verified", async () => {
    const { records, capsules } = fixture("one");
    const foreign = await capsule(capsules, "workspace-2", "foreign body");
    expect(() => records.insert({ ...hashedRecord("workspace-1", "foreign body", "foreign-link"), evidence_object_id: foreign.object_id })).toThrow();
  });

  it("binds the delivered span to emitted text instead of the larger hydration buffer", () => {
    const body = "x".repeat(1000);
    const target = sourceRecallTarget({ workspace_id: "workspace-1", root_kind: "source_record", root_id: "root",
      source_version: "v1", content_digest: SNAPSHOT_ID, evidence_object_id: null });
    const entry: IndexEntry = { schema_version: 1, target, hypothesis_id: "h0", output_binding: "default", program_state: "accepting",
      time_state: "as_of", role: "associated", association_milligrades: 1000, claim: "unknown", explanation_ids: [] };
    const payload = new BoundedIndexPayload({ workspaceId: "workspace-1", remainingMemoryBytes: 100_000,
      manifestationFor: () => "excerpt", readers: { sourceRoot: () => ({ row: { kind: "source_record", workspace_id: "workspace-1",
        root_id: "root", revision: "v1", digest: SNAPSHOT_ID, evidence_object_id: null, content: body, content_start: 0, content_end: 1000,
        content_complete: true, original_complete: true, retained_extent: "body" }, rowsRead: 1, bytesRead: 1000, unavailable: false }) } });
    const finalized = payload.finalize([entry], 100);
    const index = projectAcceptingIndex({ snapshot: { schema_version: 1, snapshot_id: SNAPSHOT_ID, query_id: "payload", seeds: [], values: [],
      retained_transitions: [], facets: [] }, view: defaultView(), query_id: "payload", snapshot_id: SNAPSHOT_ID, result_version: "v1", budget: defaultBudget() });
    const delivered = payload.applyDeliveredSpans({ ...index, entries: [entry] });
    const stamped = delivered.entries[0]!.target;
    if (stamped.kind !== "source_evidence") throw new Error("wrong target");
    const preview = [...payload.previews.values()][0]!;
    expect(stamped.span!.content_end - stamped.span!.content_start).toBeLessThanOrEqual(Buffer.byteLength(preview, "utf8"));
    if (stamped.span!.content_end < body.length) {
      expect(stamped.span!.content_complete).toBe(false);
      expect(finalized.complete).toBe(false);
    }
  });
});
