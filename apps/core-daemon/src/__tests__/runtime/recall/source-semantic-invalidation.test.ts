import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import {
  sourceSemanticExecutionPhases, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema, sourceReferenceResolver, sourceSemanticQueryIdentity,
  SourceInterpretationInvalidatedPayloadSchema, type SourceReferenceCatalog, type SourceSemanticCorrespondence,
  type SourceInterpretationInvalidation, type SourceSemanticPublishedInterpretation
} from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, EvidenceService,
  fieldContractSha256, deliveredSourceSemanticLibraryProof, sourceGoldRootIdentity,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createSourceSemanticPublication } from "../../../runtime/field/source-semantic-publication.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl, assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { accessQuery, ACCESS_BUDGET as BUDGET, CLOCK, WS } from "./source-semantic-access.test-support.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN } from
  "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { openRecallStorage, publishIndexedGeneration } from "./recall-storage.test-support.js";
import { captureFieldProofRequests } from "./field-proof-consumer.test-support.js";

const SOURCE = "Ada opened crate.";
const SOURCE_ID = "crate-source";
const ORIGINAL = "opened";
const QUERY = accessQuery(ORIGINAL);
const SCOPES = { mode: "named" as const, scopes: ["project"] };
const CONTEXT = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "interpretation-invalidation" };

async function openSession(filename: string) {
  assertBuiltWorker();
  const { database } = await openRecallStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const eventLogRepo = new SqliteEventLogRepo(database), repo = new SqliteEvidenceCapsuleRepo(database);
  const notifyEntry = vi.fn(async () => undefined);
  const evidenceService = new EvidenceService({ eventLogRepo, evidenceCapsuleRepo: repo, fieldStores: stores,
    runtimeNotifier: { notifyEntry }, now: () => CLOCK });
  const publication = createSourceSemanticPublication({ database, evidenceService });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier: { notifyEntry }, sha256: fieldContractSha256 });
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  const proofRequests = captureFieldProofRequests(client.sourceSemanticsPort);
  const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: proofRequests.port,
    sourceSemanticPublication: publication });
  await client.ready();
  return { database, stores, eventLogRepo, repo, notifyEntry, evidenceService, publication, admission, client, handler, filename, proofRequests };
}
type Session = Awaited<ReturnType<typeof openSession>>;

async function closeSession(session: Session) {
  await session.client.close(); session.database.close(); closeCachedDatabase(session.filename);
}
async function call(session: Session, args: Record<string, unknown>, context = CONTEXT) {
  return callAlayaMcpMemoryTool({ memoryToolHandler: session.handler, contextProvider: () => context },
    "soul.interpretation", SoulInterpretationRequestSchema.parse({ budget: BUDGET, authorized_scopes: SCOPES, ...args }));
}
async function output(session: Session, args: Record<string, unknown>) {
  const result = await call(session, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  if (result.structuredContent === undefined || !("output" in result.structuredContent)) throw new Error("public result required");
  const parsed = SoulInterpretationResponseSchema.parse(result.structuredContent.output);
  expect(sourceSemanticExecutionPhases(parsed.execution).query_preparation.external_api_attempts).toBe(0);
  return parsed;
}
async function prepareSource(session: Session, sourceId = SOURCE_ID) {
  const result = await output(session, { operation: "prepare_source", source_id: sourceId });
  if (result.operation !== "prepare_source" || result.source_handle === undefined || result.catalog === undefined) throw new Error("source preparation required");
  return result as typeof result & { source_handle: string; catalog: SourceReferenceCatalog };
}
function draft(catalog: SourceReferenceCatalog, reading: string) {
  const assertion = catalog.assertions[0]!;
  const text = assertion.segments.map(row => row.text).join("");
  return { contract: "source-interpretation-v4" as const,
    mentions: [{ id: "statement", assertion_id: assertion.assertion_id,
      source_ref: sourceReferenceResolver(catalog, fieldContractSha256).referenceForSpan(assertion.assertion_id, [0, text.length]) }],
    referents: [], frames: [{ id: "event", assertion_ids: [assertion.assertion_id],
      context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [],
      predicate_support: { kind: "explicit" as const, reading, mentions: ["statement"] }, slots: [], bindings: [] }],
    operators: [], gaps: [] };
}
async function publish(session: Session, reading: string) {
  const prepared = await prepareSource(session);
  const result = await output(session, { operation: "propose", source_handle: prepared.source_handle,
    draft: draft(prepared.catalog, reading), producer_id: "test-author", producer_version: "1", contract_version: "source-interpretation-v4" });
  if (result.operation !== "propose" || result.published === undefined) throw new Error("published H required");
  return result.published;
}
function correspondence(bound: SourceSemanticPublishedInterpretation): SourceSemanticCorrespondence {
  return { contract: "source-semantic-correspondence-v3", source_interpretation_id: bound.interpretation_id,
    query_semantics_id: sourceSemanticQueryIdentity(QUERY, fieldContractSha256),
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [{ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qStatement" },
      source_endpoint: { kind: "frame", frame: "event" }, query_support: { kind: "query_text", excerpt: ORIGINAL },
      source_semantic_support: [{ kind: "lexical", mentions: ["statement"] }] }] };
}
async function recall(session: Session, hypotheses: readonly SourceSemanticPublishedInterpretation[]) {
  const result = await output(session, { operation: "recall", accepts_unreviewed_conditional_results: true,
    original_query: ORIGINAL, query_semantics: QUERY, semantic_correspondences: hypotheses.map(correspondence), output_byte_limit: 1_000_000 });
  if (result.operation !== "recall") throw new Error("recall required");
  return result;
}
async function admit(session: Session, sourceId = SOURCE_ID, version = "1", evidenceId: string | null = null) {
  await session.admission.admit({ workspace_id: WS, source_id: sourceId, source_version: version, content_bytes: SOURCE,
    evidence_object_id: evidenceId, recorded_at: version === "1" ? CLOCK : "2026-09-19T00:00:00.000Z", event_time: null,
    valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE) }, { workspaceId: WS });
  // Library membership is the accepted native source-index generation, as at daemon startup.
  await publishIndexedGeneration(session.database, [{ text: SOURCE, vector: [1, 0, 0] }]);
}
function invalidation(bound: SourceSemanticPublishedInterpretation): SourceInterpretationInvalidation {
  return { workspace_id: WS, run_id: RUN, source_interpretation_id: bound.interpretation_id,
    source: { source_id: SOURCE_ID, source_version: "1", content_digest: bound.interpretation.source.content_digest },
    error_basis: { reason: "Independent inspection found that the source says opened, not sealed.", basis_ref: "authored-source-review" },
    provenance: { reporter_id: "test-reviewer" }, authorized_scopes: SCOPES };
}
function auditRows(session: Session) {
  return session.database.connection.prepare("SELECT payload_json FROM event_log WHERE event_type = 'source.interpretation.invalidated'")
    .all() as { payload_json: string }[];
}
async function failSupplement(session: Session) {
  const prepared = await prepareSource(session);
  const candidate = draft(prepared.catalog, "opened");
  const result = await output(session, { operation: "propose", source_handle: prepared.source_handle,
    draft: { ...candidate, mentions: [{ ...candidate.mentions[0], source_ref: { first: "a1s999999", last: "a1s999999" } }] },
    producer_id: "test-author", producer_version: "1", contract_version: "source-interpretation-v4" });
  expect(result).toMatchObject({ operation: "propose", outcome: { status: "invalid" } });
}

it("persists independent H invalidation through the public route and reopen while keeping corrected H and raw evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-invalidation-")), filename = join(directory, "alaya.db");
  let session = await openSession(filename);
  try {
    await admit(session);
    const bad = await publish(session, "sealed");
    const before = await recall(session, [bad]);
    const historicalEnvelope = JSON.stringify(before);
    expect(before.proofs?.map(row => row.source_interpretation_id)).toEqual([bad.interpretation_id]);
    await failSupplement(session);
    expect((await recall(session, [bad])).proofs?.map(row => row.source_interpretation_id)).toEqual([bad.interpretation_id]);
    expect(auditRows(session)).toEqual([]);
    const good = await publish(session, "opened");
    expect((await recall(session, [bad, good])).proofs).toHaveLength(2);
    const preparedQuery = await output(session, { operation: "prepare_query", original_query: ORIGINAL, query_semantics: QUERY });
    if (preparedQuery.operation !== "prepare_query" || preparedQuery.query_handle === undefined) throw new Error("query lease required");
    const prepared = await prepareSource(session);
    const reasonRequest = { operation: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: preparedQuery.query_handle, semantic_correspondence: correspondence(bad), output_byte_limit: 1_000_000 };
    expect(await output(session, reasonRequest)).toMatchObject({ operation: "reason",
      result: { outcome: { status: "interpreted" }, world_claim: "unknown", semantic_status: "unreviewed" } });
    const request = { operation: "invalidate", source_handle: prepared.source_handle,
      source_interpretation_id: bad.interpretation_id, error_basis: invalidation(bad).error_basis, reporter_id: "test-reviewer" };
    const result = await output(session, request);
    expect(result).toMatchObject({ operation: "invalidate", invalidation: { status: "invalidated", source_interpretation_id: bad.interpretation_id } });
    expect(await call(session, reasonRequest)).toMatchObject({ isError: true,
      structuredContent: { ok: false, error: { code: "VALIDATION" } } });
    await failSupplement(session);
    const after = await recall(session, [bad, good]);
    expect(after.proofs?.map(row => row.source_interpretation_id)).toEqual([good.interpretation_id]);
    const raw = await recall(session, []);
    expect(raw.proofs ?? []).toEqual([]);
    expect(JSON.stringify(raw)).toContain(SOURCE);
    const rows = auditRows(session);
    expect(rows).toHaveLength(1);
    expect(SourceInterpretationInvalidatedPayloadSchema.parse(JSON.parse(rows[0]!.payload_json))).toMatchObject({
      source_interpretation_id: bad.interpretation_id, from_state: "active", to_state: "archived", semantic_status: "unreviewed" });
    // The old proof remains an inspectable historical derivation, never a currentness oracle.
    const qualifier = before.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
    const historicalRecord = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    const historicalTrust = session.proofRequests.trust(before.delivery_id, session.stores.getStoredRecord(WS, historicalRecord.identity));
    expect(deliveredSourceSemanticLibraryProof(before.index!, before.index!.entries[qualifier.index]!, qualifier,
      before.proofs!, historicalRecord, undefined, historicalTrust).proof).toBeDefined();
    await closeSession(session); session = await openSession(filename);
    const rediscovered = await output(session, { operation: "prepare_query", original_query: ORIGINAL, query_semantics: QUERY });
    if (rediscovered.operation !== "prepare_query") throw new Error("query required");
    expect(rediscovered.candidates.map(row => row.interpretation_id)).toEqual([good.interpretation_id]);
    expect(await call(session, { ...reasonRequest, query_handle: rediscovered.query_handle })).toMatchObject({ isError: true,
      structuredContent: { ok: false, error: { code: "VALIDATION" } } });
    const current = await recall(session, [bad, good]);
    expect(current.proofs?.map(row => row.source_interpretation_id)).toEqual([good.interpretation_id]);
    const currentQualifier = current.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
    const currentRecord = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    const currentProof = deliveredSourceSemanticLibraryProof(current.index!, current.index!.entries[currentQualifier.index]!,
      currentQualifier, current.proofs!, currentRecord, undefined,
      session.proofRequests.trust(current.delivery_id, session.stores.getStoredRecord(WS, currentRecord.identity)));
    expect(currentProof.verified_proofs.map(row => row.source_interpretation_id)).toEqual([good.interpretation_id]);
    const exhausted = deliveredSourceSemanticLibraryProof(current.index!, current.index!.entries[currentQualifier.index]!,
      currentQualifier, current.proofs!, currentRecord, { ...BUDGET, work_units: 100, finalization_reserve: 10 },
      session.proofRequests.trust(current.delivery_id, session.stores.getStoredRecord(WS, currentRecord.identity)));
    expect(exhausted.proof).toBeUndefined();
    expect(exhausted.verified_proofs).toEqual([]);
    expect(exhausted.resource_usage.work_units).toBeGreaterThan(0);
    expect(exhausted.resource_usage.work_units).toBeLessThanOrEqual(100);
    expect(exhausted.resource_usage.memory_bytes).toBeGreaterThan(0);
    // Reopen changes neither the old evidence nor its historical replay meaning.
    expect(JSON.stringify(before)).toBe(historicalEnvelope);
    expect(deliveredSourceSemanticLibraryProof(before.index!, before.index!.entries[qualifier.index]!, qualifier,
      before.proofs!, currentRecord, undefined, historicalTrust).verified_proofs.map(row => row.source_interpretation_id)).toEqual([bad.interpretation_id]);
    const fresh = await prepareSource(session);
    expect(await output(session, { ...request, source_handle: fresh.source_handle })).toMatchObject({ invalidation: { status: "already_invalidated" } });
    expect(auditRows(session)).toHaveLength(1);
    const resurrection = await output(session, { operation: "propose", source_handle: fresh.source_handle,
      draft: draft(fresh.catalog, "sealed"), producer_id: "test-author", producer_version: "1", contract_version: "source-interpretation-v4" });
    expect(resurrection).toMatchObject({ outcome: { status: "invalid" } });
    expect(session.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
  } finally { await closeSession(session); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it.each(["linked_after_admission", "archived_original_alias"] as const)("invalidates a public H using the effective source alias: %s", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "source-invalidation-alias-"));
  const session = await openSession(join(directory, "alaya.db"));
  try {
    const alias = await session.evidenceService.create({ created_by: "test-author", evidence_kind: "conversation_excerpt",
      semantic_anchor: { topic: "original", keywords: [], summary: "original" }, event_anchor: null, physical_anchor: null,
      evidence_health_state: "questionable", gist: SOURCE, excerpt: SOURCE, source_hash: `sha256:${fieldContractSha256(SOURCE)}`,
      workspace_id: WS, run_id: RUN, surface_id: null });
    if (mode === "linked_after_admission") await admit(session);
    await admit(session, SOURCE_ID, "1", alias.object_id);
    if (mode === "archived_original_alias") {
      session.database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='archived' WHERE object_id=?").run(alias.object_id);
    }
    const bound = await publish(session, "sealed");
    expect(bound.source_target.evidence_object_id).toBe(mode === "linked_after_admission" ? alias.object_id : null);
    expect(session.stores.getCurrentRecord(WS, SOURCE_ID)?.evidence_object_id).toBe(mode === "linked_after_admission" ? null : alias.object_id);
    const prepared = await prepareSource(session);
    expect(await output(session, { operation: "invalidate", source_handle: prepared.source_handle,
      source_interpretation_id: bound.interpretation_id, error_basis: invalidation(bound).error_basis, reporter_id: "test-reviewer" }))
      .toMatchObject({ invalidation: { status: "invalidated" } });
    expect(auditRows(session)).toHaveLength(1);
  } finally { await closeSession(session); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("reports committed invalidation and a propagation diagnostic when its notifier rejects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-invalidation-notifier-"));
  const session = await openSession(join(directory, "alaya.db"));
  try {
    await admit(session);
    const bound = await publish(session, "sealed"), prepared = await prepareSource(session);
    session.notifyEntry.mockRejectedValueOnce(new Error("listener unavailable"));
    const result = await output(session, { operation: "invalidate", source_handle: prepared.source_handle,
      source_interpretation_id: bound.interpretation_id, error_basis: invalidation(bound).error_basis, reporter_id: "test-reviewer" });
    expect(result).toMatchObject({ invalidation: { status: "invalidated" } });
    expect(auditRows(session)).toHaveLength(1);
    const diagnostic = session.database.connection.prepare("SELECT payload_json FROM event_log WHERE event_type='runtime.side_effect_failed'").all() as { payload_json: string }[];
    expect(diagnostic).toHaveLength(1);
    expect(JSON.parse(diagnostic[0]!.payload_json)).toMatchObject({ source: "EventPublisher", operation: "post_commit_propagation" });
    expect((await recall(session, [bound])).proofs ?? []).toEqual([]);
  } finally { await closeSession(session); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("accounts for preparation plus bounded invalidation and exhausts allowance before any transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-invalidation-budget-"));
  const session = await openSession(join(directory, "alaya.db"));
  try {
    await admit(session);
    const bound = await publish(session, "sealed"), prepared = await prepareSource(session);
    const validated = await session.client.sourceSemanticsPort!.execute({ workspace_id: WS, as_of: CLOCK,
      lifetime_now: CLOCK, authorized_scopes: SCOPES, principal: JSON.stringify([CONTEXT.agentTarget, CONTEXT.sessionId, CONTEXT.runId]),
      expires_at: new Date(Date.parse(CLOCK) + 600_000).toISOString(),
      request: { kind: "validate_source", source_handle: prepared.source_handle, budget: BUDGET } });
    if (validated.kind !== "validate_source") throw new Error("validated source required");
    const request = { operation: "invalidate", source_handle: prepared.source_handle,
      source_interpretation_id: bound.interpretation_id, error_basis: invalidation(bound).error_basis, reporter_id: "test-reviewer" };
    const preparationWork = validated.work.logical_work ?? validated.work.native_work;
    for (const budget of [{ ...BUDGET, work_units: preparationWork + 1 },
      { ...BUDGET, memory_bytes: validated.work.logical_memory_bytes + 4096 }]) {
      const refused = await output(session, { ...request, budget });
      expect(refused).toMatchObject({ operation: "invalidate", outcome: { status: "resource_exhausted" } });
      expect(refused.work.logical_work).toBeLessThanOrEqual(budget.work_units);
      expect(refused.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
      expect(auditRows(session)).toEqual([]);
      expect((await recall(session, [bound])).proofs).toHaveLength(1);
    }
    const committed = await output(session, request);
    expect(committed).toMatchObject({ invalidation: { status: "invalidated" } });
    expect(committed.work.logical_work).toBeGreaterThan(preparationWork);
    expect(committed.work.logical_memory_bytes).toBeGreaterThan(validated.work.logical_memory_bytes);
    expect(committed.work.native_bytes).toBeGreaterThan(validated.work.native_bytes);
  } finally { await closeSession(session); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("keeps a frozen library continuation additive and withdraws invalidated Q/H/C support", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-invalidation-continuation-"));
  const session = await openSession(join(directory, "alaya.db"));
  try {
    await admit(session);
    for (let index = 0; index < 11; index++) await admit(session, `other-source-${index}`);
    const bound = await publish(session, "sealed"), prepared = await prepareSource(session);
    const request = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
      original_query: ORIGINAL, query_semantics: QUERY, semantic_correspondences: [correspondence(bound)],
      budget: { ...BUDGET, page_budget: 1 }, output_byte_limit: 1_000_000 };
    const execute = session.client.sourceSemanticsPort!.execute;
    const page = async (continuation?: unknown) => {
      const result = await execute({ workspace_id: WS, as_of: CLOCK, lifetime_now: CLOCK,
        expires_at: "2026-09-18T00:10:00.000Z", authorized_scopes: SCOPES, request: {
        ...request, ...(continuation === undefined ? {} : { continuation: continuation as never }) } });
      if (result.kind !== "recall") throw new Error("recall expected");
      // The frozen page is issued only through the prepared-delivery acknowledgement.
      const prepared = result as typeof result & { preparation_id?: string;
        previews?: Readonly<Record<string, string>> };
      if (prepared.preparation_id !== undefined) {
        await session.client.sourceSemanticsPort!.acknowledge!(prepared.preparation_id, result.index,
          new Map(Object.entries(prepared.previews ?? {})));
      }
      return result;
    };
    const root = sourceGoldRootIdentity(bound.source_target);
    const first = await page();
    const frozen = first.index.continuation;
    if (frozen === null) throw new Error("library continuation required");
    // A frozen page cannot be retargeted to another premise set.
    await expect(execute({ workspace_id: WS, as_of: CLOCK, lifetime_now: CLOCK, authorized_scopes: SCOPES,
      request: { ...request, semantic_correspondences: [], continuation: frozen as never } })).rejects
      .toThrow(/library continuation request changed/u);
    const roots: string[] = [];
    let proofRoots: string[] = [];
    let current = first, continuation: unknown = frozen;
    for (let index = 0; index < 12; index += 1) {
      roots.push(...current.index.entries.flatMap(entry => entry.target.kind === "source_evidence"
        ? [`${sourceGoldRootIdentity(entry.target)}`] : []));
      proofRoots = [...proofRoots, ...current.slot_qualifiers.flatMap(qualifier => {
        if (qualifier.evidence_kind !== "semantic_proof") return [];
        const entry = current.index.entries[qualifier.index]!;
        return entry.target.kind === "source_evidence" ? [`${sourceGoldRootIdentity(entry.target)}`] : [];
      })];
      if (current.index.continuation === null) break;
      continuation = current.index.continuation;
      current = await page(continuation);
    }
    // Frozen pages stay additive, and the admitted premise qualifies only its own delivered slot.
    expect(new Set(roots).size).toBe(roots.length);
    expect(proofRoots).toContain(root);
    await output(session, { operation: "invalidate", source_handle: prepared.source_handle,
      source_interpretation_id: bound.interpretation_id, error_basis: invalidation(bound).error_basis, reporter_id: "test-reviewer" });
    // Revocation applies to the actual issued capability, not only a fresh query.
    await expect(page(frozen)).rejects.toThrow(/snapshot is no longer current/u);
    // The withdrawn premise keeps its raw source page and loses every proof claim.
    const after = await page();
    expect(after.proofs ?? []).toEqual([]);
    expect(after.slot_qualifiers.every(row => row.evidence_kind === "source_evidence")).toBe(true);
    expect(after.coverage.conditional_computation).toBe("open");
  } finally { await closeSession(session); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("rolls back failed archive, rejects wrong source/workspace/currentness, and makes duplicate requests idempotent across connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-invalidation-atomic-")), filename = join(directory, "alaya.db");
  const session = await openSession(filename);
  try {
    await admit(session);
    const bad = await publish(session, "sealed");
    const request = invalidation(bad), prepared = await prepareSource(session);
    await admit(session, "other-source");
    const otherSource = await prepareSource(session, "other-source");
    const publicRequest = { operation: "invalidate", source_handle: otherSource.source_handle,
      source_interpretation_id: bad.interpretation_id, error_basis: request.error_basis, reporter_id: "test-reviewer" };
    expect((await call(session, publicRequest)).isError).toBe(true);
    expect((await call(session, { ...publicRequest, source_handle: prepared.source_handle },
      { ...CONTEXT, workspaceId: "other-workspace" })).isError).toBe(true);
    await expect(session.publication.invalidate!({ request: { ...request, workspace_id: "other-workspace" }, budget: BUDGET })).rejects.toThrow();
    await expect(session.publication.invalidate!({ request: { ...request, authorized_scopes: { mode: "named", scopes: ["global_core"] } }, budget: BUDGET })).rejects.toThrow();
    const archive = vi.spyOn(session.repo, "archiveSourceInterpretationInCurrentTransaction").mockImplementationOnce(() => { throw new Error("archive failure"); });
    session.notifyEntry.mockClear();
    await expect(session.publication.invalidate!({ request, budget: BUDGET })).rejects.toThrow("archive failure");
    archive.mockRestore();
    expect(auditRows(session)).toEqual([]);
    expect(session.notifyEntry).not.toHaveBeenCalled();
    expect((await recall(session, [bad])).proofs).toHaveLength(1);
    const secondDatabase = new StorageDatabase(filename, new BetterSqlite3(filename));
    const secondStores = createSqliteFieldFormationStores({ database: secondDatabase,
      repos: createDaemonFieldRepos({ database: secondDatabase }) });
    const secondService = new EvidenceService({ eventLogRepo: new SqliteEventLogRepo(secondDatabase),
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(secondDatabase), fieldStores: secondStores,
      runtimeNotifier: { notifyEntry: session.notifyEntry }, now: () => CLOCK });
    const secondPublication = createSourceSemanticPublication({ database: secondDatabase, evidenceService: secondService });
    let results;
    try {
      results = await Promise.all([session.publication.invalidate!({ request, budget: BUDGET }),
        secondPublication.invalidate!({ request, budget: BUDGET })]);
    } finally { secondDatabase.close(); }
    expect(results.map(row => row.invalidation.status).sort()).toEqual(["already_invalidated", "invalidated"]);
    expect(auditRows(session)).toHaveLength(1);
    expect(session.notifyEntry).toHaveBeenCalledTimes(1);
    const evidence = await session.repo.findById(results[0]!.invalidation.evidence_object_id);
    expect(evidence).toMatchObject({ lifecycle_state: "archived", gist: JSON.stringify(bad) });
    const good = await publish(session, "opened");
    const currentRequest = invalidation(good);
    const transaction = session.eventLogRepo.transactional.bind(session.eventLogRepo);
    const revised = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    await admit(session, SOURCE_ID, "2");
    const getCurrent = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
    const run = vi.spyOn(session.eventLogRepo, "transactional").mockImplementation(fn => transaction(() => {
      expect(getCurrent).not.toHaveBeenCalled();
      return fn();
    }));
    await expect(session.publication.invalidate!({ request: currentRequest, budget: BUDGET })).rejects.toThrow(/source binding/u);
    expect(getCurrent).toHaveBeenCalledWith(WS, SOURCE_ID, 1, 0, expect.objectContaining({
      nativeByteLimit: expect.any(Number),
      workLimit: expect.any(Number)
    }));
    expect(session.stores.getCurrentRecord(WS, SOURCE_ID)?.identity).not.toBe(revised.identity);
    run.mockRestore(); getCurrent.mockRestore();
    expect(auditRows(session)).toHaveLength(1);
  } finally { await closeSession(session); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
