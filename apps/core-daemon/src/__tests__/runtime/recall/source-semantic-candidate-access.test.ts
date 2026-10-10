import { expect, it, vi } from "vitest";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteFieldSourceRecordRepo, SqliteSourceHintReader,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { createAuditedSourceAdmission, encodeSourceSemanticLibraryResponse, fieldContractSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { SOURCE_SEMANTIC_PUBLISHED_CONTRACT, type SourceSemanticCorrespondence,
  type SourceSemanticPreviewExtents } from "@do-soul/alaya-protocol";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, accessQuery, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";

const orchid = "orchid irrigation", jasmine = "jasmine pruning";
const prepare = (original: string) => ({ kind: "prepare_query" as const, original_query: original,
  query_semantics: accessQuery(original), budget: ACCESS_BUDGET });

function traceSourceObservation(database: StorageDatabase, sourceId: string, previews?: SourceSemanticPreviewExtents) {
  const current = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
  const bodies = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  const capsules = vi.spyOn(SqliteSourceHintReader.prototype, "readBoundInterpretation");
  const headers = vi.spyOn(SqliteSourceHintReader.prototype, "pageBoundInterpretationHeaders");
  try {
    const meter = new SourceSemanticReadBudget(ACCESS_BUDGET);
    const pool = database.connection.transaction(() => observeSourceSemanticAccess({ database },
      { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request: prepare(orchid) },
      ["project"], meter, orchid, accessQuery(orchid), "query-conditioned-v1", ACCESS_BUDGET, sourceId, undefined, previews))();
    return { pool, work: { native_work: meter.nativeWork, native_bytes: meter.nativeBytes,
      logical_work: meter.spentWork, logical_memory_bytes: meter.spentBytes }, reads: {
      current: current.mock.calls.map(([, source]) => source),
      bodies: bodies.mock.calls.map(([, identity, maxBytes, offset], index) => {
        const result = bodies.mock.results[index];
        return { identity, maxBytes, offset: offset ?? 0,
          source: result?.type === "return" ? result.value?.record?.source_id ?? null : null };
      }), capsules: capsules.mock.calls.map(([, identity]) => identity), headers: headers.mock.calls.length
    } };
  } finally { current.mockRestore(); bodies.mockRestore(); capsules.mockRestore(); headers.mockRestore(); }
}

async function reviseSource(database: StorageDatabase, sourceId: string, scope: "project" | "global_core" = "project") {
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
  const content = `User: Revised ${sourceId} source.`;
  await admission.admit({ workspace_id: WS, source_id: sourceId, source_version: "2", content_bytes: content,
    evidence_object_id: null, recorded_at: "2026-09-19T00:00:00.000Z", event_time: null,
    valid_from: null, valid_to: null, speaker: "user", scope_class: scope, spans: deriveAddressableSpanViews(content) }, { workspaceId: WS });
}

it("excludes unrelated source reads during source-scoped observation while retaining worker proof and raw delivery", async () => {
  await withAccessLibrary([{ id: "known", text: "Orchid irrigation.", reading: orchid },
    { id: "unrelated", text: "Granite walls.", reading: "surround" }], async ({ filename, execute, ids }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      const trace = traceSourceObservation(database, "known");
      const source = await accessCall(execute, { kind: "prepare_source", source_id: "known", budget: ACCESS_BUDGET });
      const prepared = await accessCall(execute, { ...prepare(orchid), source_handle: source.source_handle });
      const raw = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
        query_handle: prepared.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
      const correspondence: SourceSemanticCorrespondence = { contract: "source-semantic-correspondence-v3",
        source_interpretation_id: ids.get("known")![0]!, query_semantics_id: prepared.query_semantics_id!,
        producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-correspondence-v3",
        correspondences: [{ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qStatement" },
          source_endpoint: { kind: "frame", frame: "fStatement" }, query_support: { kind: "query_text", excerpt: orchid },
          source_semantic_support: [{ kind: "lexical", mentions: ["mStatement"] }] }] };
      const proved = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
        query_handle: prepared.query_handle!, semantic_correspondences: [correspondence], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
      const { rss_bytes: _sourceRss, ...sourceWork } = source.work;
      const { rss_bytes: _queryRss, ...queryWork } = prepared.work;
      console.info(JSON.stringify({ observation: "source-scoped", reads: trace.reads, work: trace.work,
        worker: { source: sourceWork, query: queryWork } }));
      expect(trace.pool.descriptors.map(row => row.interpretation_id)).toEqual(ids.get("known"));
      expect(trace.pool.access).toMatchObject({ observed_source_count: 1, observed_interpretation_count: 1,
        unvisited_sources: false, unvisited_interpretations: false, stopping_reasons: [] });
      expect(trace.reads.capsules).toHaveLength(2);
      expect(trace.reads.headers).toBeGreaterThan(0);
      expect(prepared.candidates.map(row => row.source_id)).toEqual(["known"]);
      expect(prepared.candidates.map(row => row.interpretation_id)).toEqual(ids.get("known"));
      expect(prepared.coverage).toMatchObject({ discovery: "complete", semantic_correspondence: "unexercised", conditional_computation: "unexercised" });
      expect(raw.proofs ?? []).toEqual([]);
      expect(raw.index.entries).toHaveLength(1);
      expect(Object.values(raw.previews ?? {})).toContain("User: Orchid irrigation.");
      expect(raw.slot_qualifiers[0]?.evidence_kind).toBe("source_evidence");
      expect(proved.proofs?.map(proof => proof.source_interpretation_id)).toEqual(ids.get("known"));
      expect(proved.slot_qualifiers[0]?.evidence_kind).toBe("semantic_proof");
      expect(trace.work.native_work).toBeGreaterThan(0);
      expect(trace.work.native_bytes).toBeGreaterThan(0);
      expect(trace.work.logical_work).toBeLessThanOrEqual(ACCESS_BUDGET.work_units);
      expect(trace.work.logical_memory_bytes).toBeLessThanOrEqual(ACCESS_BUDGET.memory_bytes);
      expect(trace.reads.current).toContain("known");
      expect(trace.reads.bodies.map(row => row.source)).toContain("known");
      expect(trace.reads.current).not.toContain("unrelated");
      expect(trace.reads.bodies.map(row => row.source)).not.toContain("unrelated");
    } finally { database.close(); closeCachedDatabase(filename); }
  });
});

it("keeps a corrupted interpretation source identity unknown before source-scoped exclusion", async () => {
  await withAccessLibrary([{ id: "known", text: "Orchid irrigation.", reading: orchid },
    { id: "unrelated", text: "Orchid irrigation.", reading: orchid }], async ({ filename, execute, ids }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      // Equal source text prevents a different digest from rejecting the corruption first.
      // Keep the published interpretation and capsule identities while changing only source membership.
      const corrupted = database.connection.prepare("UPDATE evidence_capsules SET gist=json_set(gist,'$.interpretation.source.source_id',?) WHERE json_extract(gist,'$.interpretation_id')=?")
        .run("unrelated", ids.get("known")![0]!);
      expect(corrupted.changes).toBe(1);
      const trace = traceSourceObservation(database, "known");
      const source = await accessCall(execute, { kind: "prepare_source", source_id: "known", budget: ACCESS_BUDGET });
      const prepared = await accessCall(execute, { ...prepare(orchid), source_handle: source.source_handle });
      const raw = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
        query_handle: prepared.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
      console.info(JSON.stringify({ observation: "corrupted source identity", reads: trace.reads, work: trace.work,
        discovery: prepared.coverage.discovery, access: trace.pool.access }));
      expect(trace.pool.descriptors).toEqual([]);
      expect(prepared.candidates).toEqual([]);
      expect(raw.proofs ?? []).toEqual([]);
      expect(raw.index.entries).toHaveLength(1);
      expect(Object.values(raw.previews ?? {})).toContain("User: Orchid irrigation.");
      expect(raw.slot_qualifiers[0]?.evidence_kind).toBe("source_evidence");
      expect(trace.reads.capsules).toHaveLength(2);
      expect(trace.reads.current).not.toContain("unrelated");
      expect(trace.reads.bodies.map(row => row.source)).not.toContain("unrelated");
      expect(trace.pool.access).toMatchObject({ observed_source_count: 1, observed_interpretation_count: 0,
        unvisited_sources: false, unvisited_interpretations: true, stopping_reasons: ["unavailable"] });
      expect(prepared.coverage.discovery).toBe("truncated");
      expect(prepared.coverage.conditional_computation).toBe("unexercised");
    } finally { database.close(); closeCachedDatabase(filename); }
  });
});

it.each(["unrelated stale", "matching stale", "matching unauthorized", "unrelated malformed"] as const)
("preserves source-scoped verification and unknown states for %s interpretations", async state => {
  await withAccessLibrary([{ id: "known", text: "Orchid irrigation.", reading: orchid },
    { id: "unrelated", text: "Granite walls.", reading: "surround" }], async ({ filename, execute, ids }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      if (state === "unrelated malformed") {
        // A separate storage-corruption control has no usable source identity.
        database.connection.prepare("UPDATE evidence_capsules SET gist=? WHERE json_extract(gist,'$.interpretation.source.source_id')=?")
          .run(JSON.stringify({ contract: SOURCE_SEMANTIC_PUBLISHED_CONTRACT }), "unrelated");
      } else {
        await reviseSource(database, state === "unrelated stale" ? "unrelated" : "known",
          state === "matching unauthorized" ? "global_core" : "project");
      }
      if (state === "matching unauthorized") {
        expect(() => traceSourceObservation(database, "known")).toThrow(/scope/u);
        await expect(accessCall(execute, { kind: "prepare_source", source_id: "known", budget: ACCESS_BUDGET })).rejects.toThrow(/scope/u);
        return;
      }
      const trace = traceSourceObservation(database, "known");
      const source = await accessCall(execute, { kind: "prepare_source", source_id: "known", budget: ACCESS_BUDGET });
      const prepared = await accessCall(execute, { ...prepare(orchid), source_handle: source.source_handle });
      console.info(JSON.stringify({ observation: state, reads: trace.reads, work: trace.work }));
      const unknown = state === "unrelated malformed";
      expect(trace.pool.descriptors.map(row => row.interpretation_id)).toEqual(state === "matching stale" ? [] : ids.get("known"));
      expect(trace.pool.access).toMatchObject({ observed_source_count: 1, unvisited_sources: false,
        unvisited_interpretations: unknown, stopping_reasons: unknown ? ["unavailable"] : [] });
      expect(prepared.candidates.map(row => row.interpretation_id)).toEqual(state === "matching stale" ? [] : ids.get("known"));
      expect(prepared.coverage.discovery).toBe(unknown ? "truncated" : "complete");
      expect(prepared.coverage.conditional_computation).toBe("unexercised");
      expect(trace.reads.capsules).toHaveLength(2);
      expect(trace.reads.current).toContain("known");
      if (state === "matching stale") expect(trace.reads.current.filter(source => source === "known").length).toBeGreaterThan(1);
      expect(trace.reads.current).not.toContain("unrelated");
      expect(trace.reads.bodies.map(row => row.source)).not.toContain("unrelated");
    } finally { database.close(); closeCachedDatabase(filename); }
  });
});

it("retains a scoped preview boundary without treating a parsed unrelated interpretation as an open tail", async () => {
  await withAccessLibrary([{ id: "known", text: "Orchid irrigation.", reading: orchid },
    { id: "unrelated", text: "Granite walls.", reading: "surround" }], async ({ filename, ids }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      const current = new SqliteFieldSourceRecordRepo(database, fieldContractSha256).findCurrentBounded(WS, "known", 1)?.record;
      if (current == null) throw new Error("known source must be admitted");
      const bodyBytes = Buffer.byteLength("User: Orchid irrigation.");
      for (const byte_extent of [8, bodyBytes]) {
        const trace = traceSourceObservation(database, "known", [{ source_id: "known", source_version: current.source_version,
          record_id: current.record_id, byte_extent }]);
        const complete = byte_extent === bodyBytes;
        expect(trace.pool.access.source_candidates).toEqual([expect.objectContaining({ source_id: "known",
          read_bytes: byte_extent, body_bytes: bodyBytes, complete })]);
        expect(trace.pool.descriptors.map(row => row.interpretation_id)).toEqual(complete ? ids.get("known") : []);
        expect(trace.pool.access).toMatchObject({ unvisited_sources: !complete, unvisited_interpretations: !complete });
        expect(trace.reads.current).not.toContain("unrelated");
        expect(trace.reads.bodies.map(row => row.source)).not.toContain("unrelated");
        if (!complete) expect(trace.reads.bodies.every(row => row.offset + row.maxBytes <= byte_extent)).toBe(true);
      }
    } finally { database.close(); closeCachedDatabase(filename); }
  });
});

it("interleaves actual source, header and verification work before freezing reconciled source signals", async () => {
  await withAccessLibrary(Array.from({ length: 50 }, (_, index) => ({ id: `source-${String(index).padStart(3, "0")}`,
    text: index === 49 ? "Orchid irrigation." : "Granite walls.", reading: index === 49 ? orchid : "surround" })),
  async ({ filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const trace: { phase: string; work: number; bytes: number }[] = [];
    const reserve = SourceSemanticReadBudget.prototype.reserve, charge = SourceSemanticReadBudget.prototype.charge;
    const reserveSpy = vi.spyOn(SourceSemanticReadBudget.prototype, "reserve").mockImplementation(function (this: SourceSemanticReadBudget, ...args) {
      const result = reserve.apply(this, args);
      if (args[2] === "access source extent metadata" || args[2] === "interpretation access header page") {
        trace.push({ phase: args[2], work: this.spentWork, bytes: this.spentBytes });
      }
      return result;
    });
    const chargeSpy = vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(function (this: SourceSemanticReadBudget, ...args) {
      const result = charge.apply(this, args);
      if (args[2] === "interpretation decoding" || args[2] === "access source hint association") {
        trace.push({ phase: args[2], work: this.spentWork, bytes: this.spentBytes });
      }
      return result;
    });
    try {
      const meter = new SourceSemanticReadBudget(ACCESS_BUDGET);
      const pool = database.connection.transaction(() => observeSourceSemanticAccess({ database } as RecallReadWorkerRuntime,
        { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request: prepare(orchid) },
        ["project"], meter, orchid, accessQuery(orchid), "query-conditioned-v1", ACCESS_BUDGET))();
      const phases = trace.map(row => row.phase), firstVerification = phases.indexOf("interpretation decoding");
      expect(firstVerification).toBeGreaterThan(0);
      expect(firstVerification).toBeLessThan(phases.lastIndexOf("interpretation access header page"));
      expect(phases.slice(firstVerification + 1)).toContain("access source extent metadata");
      expect(phases.filter(phase => phase === "access source hint association")).toHaveLength(50);
      expect(trace.every((row, index) => index === 0 || row.work >= trace[index - 1]!.work
        && row.bytes >= trace[index - 1]!.bytes)).toBe(true);
      expect(pool.access).toMatchObject({ observed_source_count: 50, observed_interpretation_count: 50,
        unvisited_sources: false, unvisited_interpretations: false });
      expect(pool.descriptors[0]?.source_id).toBe("source-049");
      for (const row of pool.access.interpretation_candidates) expect(row.signal.source_text_score)
        .toBe(pool.access.source_candidates.find(source => source.record_id === row.record_id)?.signal.source_text_score);
      expect(meter.spentWork).toBeLessThanOrEqual(ACCESS_BUDGET.work_units);
      expect(meter.spentBytes).toBeLessThanOrEqual(ACCESS_BUDGET.memory_bytes);
    } finally {
      reserveSpy.mockRestore(); chargeSpy.mockRestore(); database.close(); closeCachedDatabase(filename);
    }
  });
});

it("keeps chronological verification independent of navigation arrival across pages and shared identities", async () => {
  await withAccessLibrary([{ id: "cursor", text: "Granite walls.", reading: "surround", count: 40 },
    ...["nav-one", "nav-two", "nav-three"].map(id => ({ id, text: "Orchid irrigation.", reading: orchid }))],
  async ({ filename, execute, ids }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const capsules = database.connection.prepare("SELECT object_id, json_extract(gist,'$.interpretation_id') AS interpretation_id FROM evidence_capsules")
      .all() as { object_id: string; interpretation_id: string }[];
    const cursorIds = capsules.filter(row => ids.get("cursor")!.includes(row.interpretation_id)).map(row => row.object_id).sort();
    const nominees = capsules.filter(row => !ids.get("cursor")!.includes(row.interpretation_id)).map(row => row.object_id).sort();
    const chronological = [nominees[2]!, ...cursorIds.slice(0, 15), nominees[0]!, ...cursorIds.slice(15), nominees[1]!];
    const setTime = database.connection.prepare("UPDATE evidence_capsules SET created_at=? WHERE object_id=?");
    chronological.forEach((identity, index) => setTime.run(new Date(Date.parse(CLOCK) + index * 1000).toISOString(), identity));
    const read = vi.spyOn(SqliteSourceHintReader.prototype, "readBoundInterpretation");
    try {
      const meter = new SourceSemanticReadBudget(ACCESS_BUDGET);
      const pool = database.connection.transaction(() => observeSourceSemanticAccess({ database } as RecallReadWorkerRuntime,
        { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request: prepare(orchid) },
        ["project"], meter, orchid, accessQuery(orchid), "query-conditioned-v1", ACCESS_BUDGET))();
      const attempted = read.mock.calls.map(([, identity]) => identity);
      expect(attempted.slice(0, 4)).toEqual([nominees[0], nominees[2], nominees[1], cursorIds[0]]);
      expect(new Set(attempted).size).toBe(43);
      expect(attempted).toHaveLength(43);
      expect(pool.access).toMatchObject({ observed_interpretation_count: 43,
        unvisited_sources: false, unvisited_interpretations: false });
    } finally { read.mockRestore(); database.close(); closeCachedDatabase(filename); }
    const prepared = await accessCall(execute, prepare(orchid));
    expect(prepared.candidates.slice(0, 3).map(row => row.source_id).sort()).toEqual(["nav-one", "nav-three", "nav-two"]);
    expect(prepared.access).toMatchObject({ observed_interpretation_count: 43,
      unvisited_sources: false, unvisited_interpretations: false });
  });
});

it("verifies a lexical nominee beyond an unavailable census row and reuses its complete source observation", async () => {
  await withAccessLibrary([{ id: "a", text: "Granite walls." },
    { id: "z", text: "Orchid irrigation.", reading: orchid }], async ({ filename, execute }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    database.connection.prepare("UPDATE source_records SET operator_id=? WHERE source_id='a'").run("x".repeat(9000));
    const read = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
    try {
      const meter = new SourceSemanticReadBudget(ACCESS_BUDGET);
      const pool = database.connection.transaction(() => observeSourceSemanticAccess({ database } as RecallReadWorkerRuntime,
        { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request: prepare(orchid) },
        ["project"], meter, orchid, accessQuery(orchid), "query-conditioned-v1", ACCESS_BUDGET))();
      expect(pool.sources.map(record => record.source_id)).toEqual(["z"]);
      expect(pool.descriptors.map(row => row.source_id)).toEqual(["z"]);
      expect(pool.access.source_candidates).toEqual([expect.objectContaining({ source_id: "z", complete: true,
        read_bytes: Buffer.byteLength("User: Orchid irrigation."), body_bytes: Buffer.byteLength("User: Orchid irrigation.") })]);
      expect(pool.access).toMatchObject({ unvisited_sources: true, stopping_reasons: ["unavailable"] });
      expect(read.mock.calls.filter(([, identity]) => identity === pool.sources[0]!.identity)).toHaveLength(1);
    } finally { read.mockRestore(); database.close(); closeCachedDatabase(filename); }
    const prepared = await accessCall(execute, prepare(orchid));
    expect(prepared.candidates.map(row => row.source_id)).toEqual(["z"]);
    expect(prepared.access?.source_candidates).toEqual([expect.objectContaining({ source_id: "z", complete: true })]);
    expect(prepared.access?.unvisited_sources).toBe(true);
    expect(prepared.coverage.semantic_correspondence).toBe("unexercised");
    const recalled = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
    expect(recalled.discovery.access?.pool_id).toBe(prepared.access?.pool_id);
    expect(recalled.proofs ?? []).toHaveLength(0);
  });
});

it("orders the complete observed pool for two queries before native descriptor pages and keeps raw sources without interpretations", async () => {
  await withAccessLibrary([
    { id: "filler", text: "Granite walls surround the courtyard.", reading: "surround", count: 128 },
    { id: "orchard", text: "Orchid irrigation.", reading: orchid },
    { id: "garden", text: "Jasmine pruning.", reading: jasmine },
    { id: "raw", text: "Orchid irrigation notes remain available." },
    { id: "private", text: "Orchid irrigation.", reading: orchid, scope: "global_core" }
  ], async ({ execute, ids }) => {
    const canonical = await accessCall(execute, { ...prepare(orchid), access_policy: "canonical-v1" });
    const canonicalIds = canonical.access!.interpretation_candidates.map((row) => row.interpretation_id);
    let cursor = canonical.continuation_handle;
    while (cursor !== undefined) {
      const page = await accessCall(execute, { ...prepare(orchid), access_policy: "canonical-v1", continuation_handle: cursor });
      expect(page.access?.pool_id).toBe(canonical.access?.pool_id);
      canonicalIds.push(...page.access!.interpretation_candidates.map((row) => row.interpretation_id));
      cursor = page.continuation_handle;
    }
    const first = await accessCall(execute, prepare(orchid)), second = await accessCall(execute, prepare(jasmine));
    expect(first.candidates[0]?.source_id).toBe("orchard");
    expect(second.candidates[0]?.source_id).toBe("garden");
    expect(first.access?.observed_interpretation_count).toBe(130);
    expect(first.access?.interpretation_candidates).toHaveLength(16);
    expect(first.access?.unvisited_interpretations).toBe(false);
    expect(first.access?.unvisited_sources).toBe(false);
    expect(first.access?.source_candidates.some((row) => row.source_id === "raw")).toBe(true);
    expect(first.access?.source_candidates.some((row) => row.source_id === "private")).toBe(false);
    expect(first.access?.interpretation_candidates.some((row) => ids.get("private")?.includes(row.interpretation_id))).toBe(false);
    expect(canonicalIds).toEqual([...canonicalIds].sort());
    expect(Math.max(canonicalIds.indexOf(ids.get("orchard")![0]!), canonicalIds.indexOf(ids.get("garden")![0]!))).toBeGreaterThan(32);
    expect(first.access?.pool_id).not.toBe(second.access?.pool_id);
    expect(first.access?.input_id).not.toBe(canonical.access?.input_id);
    const continued = await accessCall(execute, { ...prepare(orchid), continuation_handle: first.continuation_handle! });
    expect(continued.access?.pool_id).toBe(first.access?.pool_id);
    expect(continued.access?.trace).toMatchObject({ kind: "preparation_page", interpretation_offset: 16 });
    expect(continued.candidates).toHaveLength(16);
    expect(continued.candidates.every((row) => !first.candidates.some((prior) => prior.interpretation_id === row.interpretation_id))).toBe(true);
    const recalled = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: first.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
    expect(recalled.discovery.visited_source_interpretation_descriptors).toBe(130);
    expect(recalled.discovery.access?.pool_id).toBe(first.access?.pool_id);
    expect(recalled.discovery.access?.trace).toMatchObject({ kind: "library_selection", omitted_interpretation_count: 130 });
    expect(recalled.proofs ?? []).toHaveLength(0);
    expect(recalled.slot_qualifiers.some((row) => row.evidence_kind === "source_evidence")).toBe(true);
    const direct = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      original_query: orchid, query_semantics: accessQuery(orchid), semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
    expect(direct.discovery.access).toEqual(recalled.discovery.access);
    expect(first.work.native_bytes).toBeGreaterThan(0);
    expect(first.work.logical_work).toBeLessThanOrEqual(ACCESS_BUDGET.work_units);
    expect(first.work.logical_memory_bytes).toBeLessThanOrEqual(ACCESS_BUDGET.memory_bytes);
  });
});

it("rejects changed query, budget, policy, scope and stale revision instead of borrowing a frozen access cursor", async () => {
  await withAccessLibrary([{ id: "orchard", text: "Orchid irrigation.", reading: orchid, count: 20 }], async ({ execute, filename }) => {
    const request = prepare(orchid), first = await accessCall(execute, request);
    const continued = { ...request, continuation_handle: first.continuation_handle! };
    await expect(accessCall(execute, { ...continued, original_query: jasmine, query_semantics: accessQuery(jasmine) })).rejects.toThrow(/query|retarget/u);
    await expect(accessCall(execute, { ...continued, budget: { ...ACCESS_BUDGET, work_units: ACCESS_BUDGET.work_units - 1 } })).rejects.toThrow(/budget/u);
    await expect(accessCall(execute, { ...continued, access_policy: "canonical-v1" })).rejects.toThrow(/policy/u);
    await expect(accessCall(execute, continued, ["global_core"])).rejects.toThrow(/scope/u);
    const current = await createRecallRealStorage(() => undefined, filename);
    current.database.connection.prepare("UPDATE source_records SET scope_class = 'global_core' WHERE source_id = 'orchard'").run();
    current.database.close(); closeCachedDatabase(filename);
    await expect(accessCall(execute, continued)).rejects.toThrow(/snapshot/u);
  });
});

it("uses verified predicate readings as an access-only paraphrase bridge and leaves unsupported paraphrases unranked", async () => {
  await withAccessLibrary([
    { id: "s01", text: "The launch was put off.", reading: "postpone" },
    { id: "s02", text: "The launch went ahead.", reading: "proceed" }
  ], async ({ execute, ids }) => {
    const query = "defer", bridged = await accessCall(execute, { ...prepare(query), query_semantics: accessQuery(query, "postpone") });
    const blind = await accessCall(execute, prepare(query));
    const positive = bridged.access!.interpretation_candidates.find((row) => row.interpretation_id === ids.get("s01")![0])!;
    const foil = bridged.access!.interpretation_candidates.find((row) => row.interpretation_id === ids.get("s02")![0])!;
    expect(positive.signal.source_text_score).toBe(foil.signal.source_text_score);
    expect(positive.signal.interpretation_reading_score).toBeGreaterThan(foil.signal.interpretation_reading_score);
    expect(positive.signal.reading).toEqual({ query_alternative: 0, query_frame: "qStatement", source_frame: "fStatement" });
    expect(bridged.candidates[0]?.source_id).toBe("s01");
    expect(blind.access?.interpretation_candidates.every((row) => row.signal.interpretation_reading_score === 0)).toBe(true);
    expect(bridged.coverage.semantic_correspondence).toBe("unexercised");
    expect(bridged.coverage.conditional_computation).toBe("unexercised");
  });
});

it("preserves lexical role foils and query order under source ID and insertion order changes through the public handler", async () => {
  for (const reversed of [false, true]) {
    const sources = [{ id: reversed ? "z9" : "a1", text: "Alice helps Bob.", reading: "help" },
      { id: reversed ? "a1" : "z9", text: "Bob helps Alice.", reading: "help" },
      { id: "middle", text: "Granite walls surround the courtyard.", reading: "surround" }];
    await withAccessLibrary(reversed ? sources.reverse() : sources, async ({ execute }) => {
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
      const original = "Who helps whom: Alice or Bob?";
      const result = await handler({ operation: "prepare_query", original_query: original,
        query_semantics: accessQuery(original, "help"), budget: ACCESS_BUDGET, access_policy: "query-conditioned-v1",
        authorized_scopes: { mode: "named", scopes: ["project"] } },
      { workspaceId: WS, runId: "access-test", agentTarget: "codex", sessionId: "access-test" });
      if (result.operation !== "prepare_query") throw new Error("public preparation expected");
      expect(result.access?.source_candidates).toHaveLength(3);
      const scores = result.access!.interpretation_candidates.map((row) => row.signal);
      expect(scores[0]!.source_text_score).toBe(scores[1]!.source_text_score);
      expect(scores[1]!.source_text_score!).toBeGreaterThan(scores[2]!.source_text_score!);
      expect(scores[0]!.interpretation_reading_score).toBe(scores[1]!.interpretation_reading_score);
      expect(result.provider_attempts).toBe(0);
      expect(result.coverage.conditional_computation).toBe("unexercised");
    });
  }
});

it("treats missing and wrong hashes as hints while independently verifying shared-content roots and capsule identity", async () => {
  await withAccessLibrary([
    { id: "first", text: "The launch was put off.", reading: "postpone" },
    { id: "second", text: "The launch was put off.", reading: "postpone" },
    { id: "private", text: "The launch was put off.", reading: "postpone", scope: "global_core" }
  ], async ({ execute, filename, ids }) => {
    const request = { ...prepare("defer"), query_semantics: accessQuery("defer", "postpone") };
    for (const hint of [null, "wrong"]) {
      const current = await createRecallRealStorage(() => undefined, filename);
      current.database.connection.prepare("UPDATE evidence_capsules SET source_hash=?").run(hint);
      current.database.close(); closeCachedDatabase(filename);
      const result = await accessCall(execute, request);
      expect(result.candidates.map((row) => row.source_id).sort()).toEqual(["first", "second"]);
      expect(result.access?.unvisited_interpretations).toBe(false);
      expect(result.access?.interpretation_candidates.every((row) => row.signal.source_text_score === 0
        && row.signal.interpretation_reading_score > 0)).toBe(true);
    }
    const current = await createRecallRealStorage(() => undefined, filename);
    current.database.connection.prepare("UPDATE evidence_capsules SET gist=json_set(gist,'$.interpretation_id',?) WHERE json_extract(gist,'$.interpretation_id')=?")
      .run(ids.get("second")![0], ids.get("first")![0]);
    current.database.close(); closeCachedDatabase(filename);
    const tampered = await accessCall(execute, request);
    expect(tampered.candidates.map((row) => row.source_id)).toEqual(["second"]);
    expect(tampered.access?.unvisited_interpretations).toBe(true);
    expect(tampered.access?.stopping_reasons).toContain("unavailable");
  });
});

it.each([80_000, 200_000])("keeps unvisited growth and body tails open within %i work units", async (workUnits) => {
  await withAccessLibrary([{ id: "many", text: "Orchid irrigation.", reading: orchid, count: 60 },
    { id: "tail", text: "granite ".repeat(20_000) }], async ({ execute }) => {
    const budget = { ...ACCESS_BUDGET, work_units: workUnits, memory_bytes: 4_000_000 };
    const result = await accessCall(execute, { ...prepare(orchid), budget });
    expect(result.coverage.discovery).toBe("truncated");
    expect(result.access?.unvisited_sources).toBe(true);
    expect(result.access?.unvisited_interpretations).toBe(true);
    expect(result.access?.stopping_reasons).toContain("source_tail");
    expect(result.access?.stopping_reasons).toContain("budget");
    expect(result.access?.source_candidates.find((row) => row.source_id === "tail")?.complete).toBe(false);
    if (workUnits === 200_000) expect(result.access?.source_candidates.find((row) => row.source_id === "tail")?.read_bytes).toBeGreaterThan(0);
    expect(result.work.logical_work).toBeLessThanOrEqual(budget.work_units);
    expect(result.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
  });
});

it("pages all 512 observed source traces without rereading or overflowing the public envelope", async () => {
  await withAccessLibrary(Array.from({ length: 512 }, (_, index) => ({ id: `source-${String(index).padStart(3, "0")}`,
    text: "Orchid irrigation notes remain available." })), async ({ execute }) => {
    const prepared = await accessCall(execute, prepare(orchid));
    const request = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
      query_handle: prepared.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 100_000 };
    expect(prepared.access?.observed_source_count).toBe(512);
    expect(prepared.access?.source_candidates).toHaveLength(16);
    expect(prepared.access?.unvisited_sources).toBe(true);
    const recalled = await accessCall(execute, request);
    const publicBytes = Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(recalled)));
    expect(publicBytes).toBeLessThanOrEqual(request.output_byte_limit);
    expect(recalled.discovery.access?.source_candidates.length).toBeLessThanOrEqual(10);
    expect(recalled.discovery.access?.trace).toMatchObject({ kind: "library_selection", omitted_source_count: 507 });
    const seen = new Set(prepared.access!.source_candidates.map((row) => row.record_id));
    let cursor = prepared.continuation_handle, sourceOffset = 16;
    while (cursor !== undefined) {
      const page = await accessCall(execute, { ...prepare(orchid), continuation_handle: cursor });
      expect(page.access?.pool_id).toBe(prepared.access?.pool_id);
      expect(page.access?.trace).toMatchObject({ kind: "preparation_page", source_offset: sourceOffset });
      expect(page.work.native_work).toBe(0);
      expect(page.work.native_bytes).toBe(0);
      expect(page.candidates).toHaveLength(0);
      for (const row of page.access!.source_candidates) { expect(seen.has(row.record_id)).toBe(false); seen.add(row.record_id); }
      sourceOffset += page.access!.source_candidates.length;
      cursor = page.continuation_handle;
    }
    expect(seen.size).toBe(512);
    expect(Buffer.byteLength(JSON.stringify(prepared.access))).toBeLessThan(5_000);
    expect(Buffer.byteLength(JSON.stringify(recalled.discovery.access))).toBeLessThan(4_000);
  });
}, 60_000);

it("keeps a complete source census complete while a later trace page remains unshown", async () => {
  await withAccessLibrary(Array.from({ length: 17 }, (_, index) => ({ id: `source-${index}`, text: "Orchid irrigation." })), async ({ execute }) => {
    const first = await accessCall(execute, prepare(orchid));
    expect(first.access?.observed_source_count).toBe(17);
    expect(first.access?.unvisited_sources).toBe(false);
    expect(first.access?.trace).toMatchObject({ kind: "preparation_page", source_offset: 0, omitted_source_count: 1 });
    expect(first.candidates).toHaveLength(0);
    expect(first.coverage.discovery).toBe("complete");
    expect(first.truncated).toBe(true);
    const next = await accessCall(execute, { ...prepare(orchid), continuation_handle: first.continuation_handle! });
    expect(next.access?.pool_id).toBe(first.access?.pool_id);
    expect(next.access?.trace).toMatchObject({ kind: "preparation_page", source_offset: 16 });
    expect(next.work.native_bytes).toBe(0);
    expect(next.continuation_handle).toBeUndefined();
    expect(next.coverage.discovery).toBe("complete");
    expect(next.truncated).toBe(false);
  });
});

it("returns resource exhaustion instead of a partly expired handle pair", async () => {
  const original = "orchid irrigation";
  const semantics = { ...accessQuery(original), gaps: Array.from({ length: 220 }, () => ({
    kind: "unsupported_meaning" as const, affected_ids: ["statement"],
    support: [{ kind: "query_text" as const, excerpt: "orchid" }], description: "detail ".repeat(110)
  })) };
  const sources = Array.from({ length: 512 }, (_, index) => ({
    id: `source-${String(index).padStart(3, "0")}-${"x".repeat(240)}`,
    text: "Orchid irrigation.", reading: original
  }));
  await withAccessLibrary(sources, async ({ execute }) => {
    const request = { ...prepare(original), query_semantics: semantics };
    const prepared = await accessCall(execute, request);
    expect(prepared.outcome).toEqual({ status: "resource_exhausted" });
    expect(prepared.query_handle).toBeUndefined();
    expect(prepared.continuation_handle).toBeUndefined();
  });
}, 120_000);

it("keeps both handles from a fitting preparation usable through the worker", async () => {
  await withAccessLibrary(Array.from({ length: 17 }, (_, index) => ({
    id: `source-${index}`, text: "Orchid irrigation."
  })), async ({ execute }) => {
    const request = prepare(orchid);
    const prepared = await accessCall(execute, request);
    expect(prepared.query_handle).toBeDefined();
    expect(prepared.continuation_handle).toBeDefined();
    const recalled = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET,
      output_byte_limit: 1_000_000 });
    expect(recalled.kind).toBe("recall");
    const next = await accessCall(execute, { ...request, continuation_handle: prepared.continuation_handle! });
    expect(next.access?.pool_id).toBe(prepared.access?.pool_id);
  });
});

it("reads a raw-only body beyond the general observation half after proving no capsules", async () => {
  const original = "orchid irrigation";
  await withAccessLibrary([{ id: "raw", text: "Orchid irrigation. ".repeat(600) }], async ({ execute, filename }) => {
    const budget = { ...ACCESS_BUDGET, work_units: 180_000, memory_bytes: 4_000_000 };
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const runtime = { database } as RecallReadWorkerRuntime;
    const childSpend: number[] = [];
    const absorb = SourceSemanticReadBudget.prototype.absorb;
    const spy = vi.spyOn(SourceSemanticReadBudget.prototype, "absorb").mockImplementation(function (this: SourceSemanticReadBudget, child) {
      if (child.nativeBytes > 0) childSpend.push(child.spentWork);
      return absorb.call(this, child);
    });
    try {
      const direct = database.connection.transaction(() => observeSourceSemanticAccess(runtime,
        { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
          request: { kind: "prepare_query", original_query: original, budget } },
        ["project"], new SourceSemanticReadBudget(budget), original, undefined, "query-conditioned-v1", budget, undefined,
        { leaseContext: { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
          expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: original } }))();
      expect(direct.access.source_candidates[0]?.complete).toBe(true);
      const prepared = await accessCall(execute, { kind: "prepare_query", original_query: original, budget });
      expect(prepared.outcome).toEqual({ status: "preparation_required", missing: "query_semantics" });
      expect(prepared.access?.source_candidates).toEqual([expect.objectContaining({ source_id: "raw", complete: true })]);
      expect(prepared.access?.unvisited_sources).toBe(false);
      expect(prepared.query_handle).toBeDefined();
      expect(childSpend).toEqual([expect.any(Number)]);
      expect(childSpend[0]).toBeGreaterThan(Math.floor(budget.work_units / 2));
    } finally { spy.mockRestore(); database.close(); closeCachedDatabase(filename); }
  });
});

it("reports census and header work when empty-population planning exhausts its protected allowance", async () => {
  await withAccessLibrary([{ id: "raw", text: "Orchid irrigation." }], async ({ execute, filename }) => {
    const budget = { ...ACCESS_BUDGET, work_units: 8_000, memory_bytes: 24_000 };
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const runtime = { database } as RecallReadWorkerRuntime;
    const meter = new SourceSemanticReadBudget(budget);
    const planning = vi.fn();
    const charge = SourceSemanticReadBudget.prototype.charge;
    const spy = vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(function (this: SourceSemanticReadBudget, ...args) {
      if (args[2] === "empty interpretation completion planning") planning();
      return charge.apply(this, args);
    });
    try {
      expect(() => database.connection.transaction(() => observeSourceSemanticAccess(runtime,
        { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
          request: { kind: "prepare_query", original_query: orchid, budget } },
        ["project"], meter, orchid, undefined, "query-conditioned-v1", budget, undefined,
        { leaseContext: { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
          expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: orchid } }))()).toThrow();
      const result = await accessCall(execute, { kind: "prepare_query", original_query: orchid, budget });
      expect(planning).toHaveBeenCalledOnce();
      expect(result.outcome).toEqual({ status: "resource_exhausted" });
      expect(meter.nativeWork).toBeGreaterThan(0);
      expect(meter.nativeBytes).toBeGreaterThan(0);
      expect(meter.spentWork).toBeLessThanOrEqual(budget.work_units);
      expect(meter.spentBytes).toBeLessThanOrEqual(budget.memory_bytes);
      expect(result.work.native_work).toBeGreaterThan(0);
      expect(result.work.native_bytes).toBeGreaterThan(0);
      expect(result.work.logical_work).toBeGreaterThan(result.work.native_work);
      expect(result.work.logical_work).toBeLessThanOrEqual(budget.work_units);
      expect(result.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
    } finally { spy.mockRestore(); database.close(); closeCachedDatabase(filename); }
  });
});

it.each([0, 1, 16, 17])("keeps a proved empty capsule pool pageable for %i raw sources and either query state", async (count) => {
  await withAccessLibrary(Array.from({ length: count }, (_, index) => ({ id: index === 0 ? 'raw-"雪\\' : `raw-${index}`,
    text: "Orchid irrigation." })),
  async ({ execute }) => {
    for (const query_semantics of [undefined, accessQuery(orchid)]) {
      const request = { kind: "prepare_query" as const, original_query: orchid, query_semantics, budget: ACCESS_BUDGET };
      const prepared = await accessCall(execute, request);
      expect(prepared.access).toMatchObject({ observed_source_count: count, observed_interpretation_count: 0,
        unvisited_sources: false, unvisited_interpretations: false });
      expect(prepared.access?.source_candidates).toHaveLength(Math.min(count, 16));
      expect(prepared.query_handle).toBeDefined();
      expect(prepared.continuation_handle === undefined).toBe(count <= 16);
      expect(prepared.outcome?.status).toBe(query_semantics === undefined ? "preparation_required" : undefined);
      if (prepared.continuation_handle !== undefined) {
        const page = await accessCall(execute, { ...request, continuation_handle: prepared.continuation_handle });
        expect(page.access?.pool_id).toBe(prepared.access?.pool_id);
        expect(page.access?.source_candidates).toHaveLength(1);
        expect(page.work.native_bytes).toBe(0);
      }
    }
  });
});

it("does not promote an inactive capsule merely because it yields no verified interpretation", async () => {
  await withAccessLibrary([{ id: "raw", text: "Orchid irrigation. ".repeat(600), reading: orchid }],
  async ({ execute, filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='archived'").run();
    const runtime = { database } as RecallReadWorkerRuntime;
    const budget = { ...ACCESS_BUDGET, work_units: 180_000, memory_bytes: 4_000_000 };
    const planning = vi.fn(), charge = SourceSemanticReadBudget.prototype.charge;
    const spy = vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(function (this: SourceSemanticReadBudget, ...args) {
      if (args[2] === "empty interpretation completion planning") planning();
      return charge.apply(this, args);
    });
    try {
      const pool = database.connection.transaction(() => observeSourceSemanticAccess(runtime,
        { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
          request: { kind: "prepare_query", original_query: orchid, budget } },
        ["project"], new SourceSemanticReadBudget(budget), orchid, undefined, "query-conditioned-v1", budget, undefined,
        { leaseContext: { workspace_id: WS, principal: "", as_of: CLOCK, authorized: ["project"],
          expires_at: "2026-09-18T00:10:00.000Z", revision: "test", original_query: orchid } }))();
      expect(planning).not.toHaveBeenCalled();
      expect(pool.access.observed_interpretation_count).toBe(0);
      expect(pool.access.source_candidates[0]?.complete).toBe(false);
    } finally { spy.mockRestore(); database.close(); closeCachedDatabase(filename); }
    const prepared = await accessCall(execute, { kind: "prepare_query", original_query: orchid, budget });
    expect(prepared.access?.observed_interpretation_count).toBe(0);
    expect(prepared.access?.source_candidates[0]?.complete).toBe(false);
    expect(prepared.access?.unvisited_sources).toBe(true);
  });
});
