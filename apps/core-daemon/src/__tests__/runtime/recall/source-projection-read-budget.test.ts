import { afterEach, expect, it, vi } from "vitest";
import { indexEntryCacheKey, type SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, encodeSourceSemanticLibraryResponse, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { ACCESS_BUDGET, CLOCK, WS, accessQuery } from "./source-semantic-access.test-support.js";

const databases: StorageDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close(); });
const original = "orchid irrigation", text = "Orchid irrigation.";

async function fixture() {
  const { database } = await createRecallRealStorage(() => undefined); databases.push(database);
  const admission = createAuditedSourceAdmission({
    stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
    eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  });
  const common = { workspace_id: WS, source_version: "1", content_bytes: text, evidence_object_id: null,
    recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null, speaker: "assistant" as const,
    scope_class: "project" as const, spans: [] };
  const raw = await admission.admit({ ...common, source_id: "source-raw", source_representation: { kind: "retained_excerpt" } }, { workspaceId: WS });
  const projection = await admission.admit({ ...common, source_id: "source-projection", source_representation: {
    kind: "canonical_projection", source_record_ids: [raw.record.identity] } }, { workspaceId: WS });
  const runtime = createRecallReadWorkerRuntime(database);
  const request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }> = { kind: "recall",
    original_query: original, query_semantics: accessQuery(original), semantic_correspondences: [],
    accepts_unreviewed_conditional_results: true, budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 };
  const payload = { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named" as const, scopes: ["project"] }, request };
  return { database, runtime, raw: raw.record, projection: projection.record, payload };
}

it("charges each projection dependency read during source-scoped observation and preserves the observed text", async () => {
  const ctx = await fixture();
  const observe = (sourceId: string) => {
    const ledger = new SourceSemanticReadBudget(ACCESS_BUDGET);
    const pool = ctx.database.connection.transaction(() => observeSourceSemanticAccess(ctx.runtime, ctx.payload,
      ["project"], ledger, original, accessQuery(original), "query-conditioned-v1", ACCESS_BUDGET, sourceId))();
    return { pool, ledger };
  };
  const raw = observe(ctx.raw.source_id), reads = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  const projection = observe(ctx.projection.source_id);
  // One currentness read, one extent read and one full chunk each require the same two origin facts.
  expect(reads).toHaveBeenCalledTimes(2);
  expect(projection.ledger.nativeWork - raw.ledger.nativeWork).toBe(6);
  expect(projection.pool.access.source_candidates).toMatchObject([{ complete: true, read_bytes: Buffer.byteLength(text) }]);
  expect(projection.pool.access.source_candidates[0]!.signal).toEqual(raw.pool.access.source_candidates[0]!.signal);
  expect(reads.mock.calls.every(call => call[4]?.workLimit !== undefined && call[4]?.nativeByteLimit !== undefined)).toBe(true);
});

it("encodes retained excerpt and canonical projection disclosures with their exact source lineage", async () => {
  const ctx = await fixture(), result = runSourceSemanticWorker(ctx.runtime, ctx.payload);
  if (result.kind !== "recall") throw new Error("expected library recall");
  for (const record of [ctx.raw, ctx.projection]) {
    const entry = result.index.entries.find(row => row.target.kind === "source_evidence" && row.target.root_id === record.identity);
    expect(entry).toBeDefined();
    expect(result.source_disclosures[indexEntryCacheKey(entry!)]).toMatchObject({
      material_kind: record.source_representation!.kind, source_representation: record.source_representation });
  }
  const encoded = encodeSourceSemanticLibraryResponse(result);
  if (encoded.operation !== "recall") throw new Error("expected encoded library recall");
  expect(encoded.source_disclosures).toEqual(result.source_disclosures);
  expect(encoded.results?.map(row => row.source_disclosure?.material_kind).sort()).toEqual(["canonical_projection", "retained_excerpt"]);
});

it("reports an unfinished source observation and budget stop when dependency admission refuses its extent", async () => {
  const ctx = await fixture(), reads = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  const observe = (budget: typeof ACCESS_BUDGET) => {
    const ledger = new SourceSemanticReadBudget(budget);
    const pool = ctx.database.connection.transaction(() => observeSourceSemanticAccess(ctx.runtime, ctx.payload,
      ["project"], ledger, original, accessQuery(original), "query-conditioned-v1", budget, ctx.projection.source_id))();
    return { pool, ledger };
  };
  observe(ACCESS_BUDGET);
  const firstAllowance = reads.mock.calls[0]![4]!.workLimit!;
  reads.mockClear();
  const budget = { ...ACCESS_BUDGET, work_units: ACCESS_BUDGET.work_units - 2 * (firstAllowance - 6), finalization_reserve: 0 };
  const limited = observe(budget);
  expect(reads.mock.results[0]!.value).toMatchObject({ resourceLimited: true, dependencyWork: 0, nativeBytes: 0 });
  expect(limited.pool.access.source_candidates).toMatchObject([{ complete: false, read_bytes: 0,
    signal: { source_text_score: null } }]);
  expect(limited.pool.access.stopping_reasons).toContain("budget");
  expect(limited.pool.access.stopping_reasons).not.toContain("unavailable");
  expect(limited.pool.access.unvisited_sources).toBe(true);
  expect(limited.ledger.spentWork).toBeLessThanOrEqual(budget.work_units);
});

it("refuses a projection prefix before dependency or content reads when only the base read fits", async () => {
  const ctx = await fixture(), result = runSourceSemanticWorker(ctx.runtime, ctx.payload);
  if (result.kind !== "recall") throw new Error("expected library recall");
  const entry = result.index.entries.find(row => row.target.kind === "source_evidence" && row.target.root_id === ctx.projection.identity)!;
  const prepare = vi.spyOn(ctx.database.connection, "prepare");
  const reads = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  const limited = new SourceSemanticReadBudget({ work_units: 6, memory_bytes: ACCESS_BUDGET.memory_bytes });
  expect(prepareLibraryPackages(ctx.runtime, ctx.payload, ["project"], limited, [entry], [])).toEqual({ packages: [], incomplete: true });
  expect(reads.mock.results[0]!.value).toMatchObject({ resourceLimited: true, nativeBytes: 0, dependencyWork: 0, record: { source_body: null } });
  expect(prepare.mock.calls.some(([sql]) => sql.includes("FROM source_records origin"))).toBe(false);
  expect(limited.nativeWork).toBe(5);
  expect(limited.nativeBytes).toBeGreaterThan(0);
  const sufficient = new SourceSemanticReadBudget(ACCESS_BUDGET);
  const restored = prepareLibraryPackages(ctx.runtime, ctx.payload, ["project"], sufficient, [entry], []);
  expect(restored.incomplete).toBe(false);
  expect(restored.packages[0]?.preview).toBe(text);
  expect(sufficient.nativeWork).toBe(7);
});
