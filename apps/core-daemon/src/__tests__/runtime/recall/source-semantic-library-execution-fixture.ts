import { expect, vi } from "vitest";
import { SourceIndexAcquisition, assembleSourceSemanticLibraryIndex, createAuditedSourceAdmission,
  encodeSourceSemanticLibraryResponse, fieldContractSha256, preparedDeliveryId, sealIssuedContinuation,
  sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { indexEntryCacheKey, SourceSemanticWorkerResultSchema, type SourceSemanticExecution,
  type SourceSemanticWorkerRequest, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { queryDatabase, BUDGET, CLOCK, ORIGINAL, WS, query } from "./source-semantic-query-preparation-fixture.js";
import { correspondenceFor, deliveredProofFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { loadVerified } from "../../../runtime/recall-read-worker/source-semantic-discovery.js";

export { BUDGET, CLOCK, ORIGINAL, WS };
export const RAW_ID = "reservation-raw";
export const RAW_BODY = "An independently admitted original source.";
export const SCOPES = { mode: "named" as const, scopes: ["project"] };
export type RecallRequest = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;
export type RecallResult = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
export const payload = (request: SourceSemanticWorkerRequest) => ({ workspace_id: WS, as_of: CLOCK,
  lifetime_now: CLOCK, principal: "execution-reservation", authorized_scopes: SCOPES, request });
// Independent public reservation envelope: keep index work and its partial native accounting.
export const RESERVED_WORK = { native_work: BUDGET.work_units, index_work: BUDGET.work_units,
  native_accounting: "partial" as const, logical_work: BUDGET.work_units,
  native_bytes: BUDGET.memory_bytes, logical_memory_bytes: BUDGET.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER };

/** Real publication/SQLite/index lifecycle; numerical embedding and preparation duration are fixed.
 * No provider, model, tokenizer download, recorded cache, or external corpus participates.
 */
export async function executionLibrary(withRaw = false) {
  const database = await queryDatabase({ publishInterpretation: true });
  try {
    const runtime = createRecallReadWorkerRuntime(database.database);
    const verified = loadVerified(runtime, WS, database.sourceInterpretationId!, ["project"], new SourceSemanticReadBudget(BUDGET));
    const semantics = query();
    const authored = correspondenceFor(verified.bound.interpretation, semantics);
    const correspondence = { ...authored, correspondences: authored.correspondences.map(row => ({ ...row,
      source_semantic_support: row.source_semantic_support.map(support => support.kind === "lexical"
        ? { ...support, mentions: support.mentions.map(id => id === "muses" ? "mUses" : id) } : support) })) };
    // This fixture executes the genuine conditional engine; it is not an injected solved result.
    const proof = deliveredProofFixture({ interpretation: verified.bound.interpretation, semantics,
      correspondence, library: true, workspaceId: WS });
    expect(proof.proof.outcome.status).toBe("interpreted");
    expect(proof.proof.binding_results).toHaveLength(1);
    if (withRaw) {
      const admission = createAuditedSourceAdmission({ stores: createSqliteFieldFormationStores({ database: database.database,
        repos: createDaemonFieldRepos({ database: database.database }) }), eventLogRepo: new SqliteEventLogRepo(database.database),
      runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
      await admission.admit({ workspace_id: WS, source_id: RAW_ID, source_version: "1", content_bytes: RAW_BODY,
        evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
        speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    }
    const embed = vi.fn(database.binding.embedInputs);
    const prepare = vi.fn(async (input: { navigation: string; signal: AbortSignal; remainingMs: () => number }) => {
      const result = await SourceIndexAcquisition.prepareQuery({ ...input, selection: database.selection,
        bind: async () => ({ ...database.binding, embedInputs: embed }) });
      // Exact byte-cap tests must not depend on the JSON length of wall-clock telemetry.
      // Keep genuine preparation/binding results; author only this fixture's simulated duration.
      return { ...result, receipt: { ...result.receipt, elapsed_ms: 1 } };
    });
    const prepared = await prepare({ navigation: ORIGINAL, signal: new AbortController().signal, remainingMs: () => 60_000 });
    // The reused index fixture has an external-provider profile. Its simulated binding
    // supplies no HTTP-attempt measurement: preserve null rather than manufacture zero.
    expect(prepared.receipt).toMatchObject({ status: "ready", submitted_inputs: 1, token_count: 2,
      method: "external_api", external_api_attempts: null, binding_work: "unknown", execution_work: "unknown" });
    const request: RecallRequest = { kind: "recall", accepts_unreviewed_conditional_results: true,
      original_query: ORIGINAL, query_semantics: semantics, semantic_correspondences: [correspondence],
      budget: BUDGET, output_byte_limit: 1_000_000 };
    return { ...database, runtime, semantics, proof, request, prepared, prepare, embed };
  } catch (error) { database.cleanup(); throw error; }
}
export type ExecutionLibrary = Awaited<ReturnType<typeof executionLibrary>>;

function evidenceTarget(entry: RecallResult["index"]["entries"][number]) {
  if (entry.target.kind !== "source_evidence") throw new Error("source target expected");
  return entry.target;
}

/** Independently assemble one page from a roomy recall. Never supplied as a worker/solver result. */
export function assembledSourcePage(full: RecallResult, rootIds: readonly string[], options: {
  execution: SourceSemanticExecution; moreRoots: boolean; emittedOffset: number; proofs: boolean;
}): RecallResult {
  const entries = rootIds.map(rootId => {
    const entry = full.index.entries.find(row => row.target.kind === "source_evidence" && row.target.root_id === rootId);
    if (entry === undefined) throw new Error("source entry expected");
    return entry;
  });
  const positions = entries.map(entry => full.index.entries.indexOf(entry));
  const keys = entries.map(entry => indexEntryCacheKey(entry));
  const access = full.discovery.access!;
  const records = new Set(rootIds);
  const interpretations = access.interpretation_candidates.filter(row =>
    full.discovery.examined_source_interpretation_ids.includes(row.interpretation_id));
  for (const row of interpretations) records.add(row.record_id);
  const source_candidates = access.source_candidates.filter(row => records.has(row.record_id));
  const assembled = assembleSourceSemanticLibraryIndex({
    query_id: full.index.query_id, snapshot_id: full.index.snapshot_id,
    interpretation_id: full.index.interpretation_id!, as_of: CLOCK,
    source_entries: entries, selected_entries: entries,
    root_order: entries.map(entry => sourceGoldRootIdentity(evidenceTarget(entry))),
    proof_groups: options.proofs ? [{ entries, explanations: full.index.explanations }] : [],
    truncated: false, open_residuals: false, more_roots: options.moreRoots,
    emitted_offset: options.emittedOffset, expires_at: "2026-09-18T00:05:00.000Z",
    authorized_scopes: ["project"] });
  const index = assembled.index.continuation === null ? assembled.index
    : { ...assembled.index, continuation: sealIssuedContinuation(assembled.index.continuation) };
  const proofs = options.proofs ? full.proofs?.filter(row => rootIds.includes(row.source_record.identity)) : undefined;
  const { proofs: _dropped, ...rest } = full;
  const page = SourceSemanticWorkerResultSchema.parse({ ...rest, execution: options.execution, index, total_count: entries.length,
    delivery_id: preparedDeliveryId(full.request_identity, index),
    slot_qualifiers: positions.flatMap((position, index) => full.slot_qualifiers.filter(row => row.index === position)
      .map(row => ({ ...row, index }))),
    ...(proofs !== undefined && proofs.length > 0 ? { proofs } : {}),
    previews: Object.fromEntries(keys.map(key => [key, full.previews![key]!])),
    source_disclosures: Object.fromEntries(keys.map(key => [key, full.source_disclosures[key]!])),
    discovery: { ...full.discovery, access: { ...access, source_candidates, interpretation_candidates: interpretations,
      trace: { kind: "library_selection", omitted_source_count: access.observed_source_count - source_candidates.length,
        omitted_interpretation_count: access.observed_interpretation_count - interpretations.length } } } });
  if (page.kind !== "recall") throw new Error("source page expected");
  return page;
}

/** Complete public encoder bytes, including reserved work and excluding optional source time. */
export function publicReservationBytes(result: RecallResult, execution: SourceSemanticExecution): number {
  const source_disclosures = Object.fromEntries(Object.entries(result.source_disclosures).map(([key, value]) => {
    const { source_time: _optional, ...mandatory } = value;
    return [key, mandatory];
  }));
  return Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse({
    ...result, execution, source_disclosures, work: RESERVED_WORK })));
}

/** Exact inclusive cap that every `fits` envelope satisfies and every `exceeds` envelope misses. */
export function discriminatingByteCap(fits: readonly number[], exceeds: readonly number[]): number {
  const cap = Math.max(...fits);
  if (!Number.isSafeInteger(cap) || exceeds.some(bytes => bytes <= cap)) {
    throw new Error(`no independent discriminating cap: fits ${fits.join(",")} exceeds ${exceeds.join(",")}`);
  }
  return cap;
}
