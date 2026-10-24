import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  sourceSemanticExecutionPhases, RunMode, RunState, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  sourceReferenceResolver, sourceSemanticCorrespondenceIdentity, sourceSemanticQueryIdentity,
  type SourceReferenceCatalog, type SourceSemanticCorrespondence, type SourceSemanticGenerationTask,
  type SourceSemanticPublishedInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  createAuditedSourceAdmission, deliveredSourceSemanticLibraryProof, EvidenceService,
  fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteRunRepo } from "@do-soul/alaya-storage";
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

// Authored conditional control: this is neither captured CLI work nor model-produced meaning.
const SOURCE = "Typecheck passed. Golden snapshot updated.";
const SOURCE_ID = "developer-validation-observation";
const SCOPES = { mode: "named" as const, scopes: ["project"] };
const TASK_A = "Show the observation that typecheck passed.";
const TASK_B = "List evidence that type checking succeeded or the golden snapshot was refreshed.";
const CONTEXT_A = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "validation-task" };
const CONTEXT_B = { workspaceId: WS, runId: "handoff-run", agentTarget: "codex", sessionId: "handoff-task" };
type Context = typeof CONTEXT_A;
type Trace = { boundary: string; value: unknown }[];

function task(original_query: string): SourceSemanticGenerationTask {
  return { contract: "source-semantic-generation-task-v1", context: "complete_original_source", original_query,
    responsibility: { kind: "original_query_task", other_meaning: "unassessed" } };
}

function queries() {
  const a: SourceSemanticQuery = { ...accessQuery(TASK_A, "typecheck passed"),
    approved_fixed_context: { context_id: "validation", notes: "Inspect the retained validation observation." } };
  const b: SourceSemanticQuery = { ...accessQuery(TASK_B, "type checking succeeded"),
    approved_fixed_context: { context_id: "release-handoff", notes: "Collect available handoff evidence; completeness is not assumed." },
    alternatives: [accessQuery(TASK_B, "type checking succeeded").alternatives[0]!,
      accessQuery(TASK_B, "golden snapshot was refreshed").alternatives[0]!] };
  return { a, b };
}

async function openSession(filename: string, trace: Trace) {
  assertBuiltWorker();
  const { database } = await openRecallStorage(() => undefined, filename);
  const runRepo = new SqliteRunRepo(database);
  if (await runRepo.getById(CONTEXT_B.runId) === null) await runRepo.create({ run_id: CONTEXT_B.runId,
    workspace_id: WS, title: "Release handoff", goal: null, run_mode: RunMode.CHAT, engine_binding_id: null,
    engine_class: null, run_state: RunState.IDLE, current_surface_id: null });
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const evidenceService = new EvidenceService({ eventLogRepo, evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    fieldStores: stores, runtimeNotifier: { notifyEntry: async () => undefined }, now: () => CLOCK });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo,
    runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  const proofRequests = captureFieldProofRequests(client.sourceSemanticsPort!);
  const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
    sourceSemanticsPort: proofRequests.port,
    sourceSemanticPublication: createSourceSemanticPublication({ database, evidenceService }) });
  await client.ready();
  return { database, stores, admission, client, handler, filename, trace, proofRequests };
}
type Session = Awaited<ReturnType<typeof openSession>>;

async function closeSession(session: Session) {
  await session.client.close();
  session.database.close();
  closeCachedDatabase(session.filename);
}

async function call(session: Session, context: Context, args: Record<string, unknown>) {
  const request = SoulInterpretationRequestSchema.parse({ budget: BUDGET, authorized_scopes: SCOPES, ...args });
  const response = await callAlayaMcpMemoryTool({ memoryToolHandler: session.handler, contextProvider: () => context },
    "soul.interpretation", request);
  session.trace.push({ boundary: "public_mcp", value: { context, request, response } });
  return response;
}

async function output(session: Session, context: Context, args: Record<string, unknown>) {
  const response = await call(session, context, args);
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  if (response.structuredContent === undefined || !("output" in response.structuredContent)) throw new Error("public output required");
  const parsed = SoulInterpretationResponseSchema.parse(response.structuredContent.output);
  expect(sourceSemanticExecutionPhases(parsed.execution).query_preparation.external_api_attempts).toBe(0);
  return parsed;
}

async function prepareSource(session: Session, context: Context) {
  const result = await output(session, context, { operation: "prepare_source", source_id: SOURCE_ID });
  if (result.operation !== "prepare_source" || result.source_handle === undefined || result.catalog === undefined) {
    throw new Error("source handle and catalog required");
  }
  return { handle: result.source_handle, catalog: result.catalog };
}

function draft(catalog: SourceReferenceCatalog, phrase: string, reading: string) {
  const assertion = catalog.assertions.find(row => row.segments.map(segment => segment.text).join("").includes(phrase))!;
  const text = assertion.segments.map(row => row.text).join("");
  const start = text.indexOf(phrase);
  return { contract: "source-interpretation-v4" as const, mentions: [{ id: "statement", assertion_id: assertion.assertion_id,
    source_ref: sourceReferenceResolver(catalog, fieldContractSha256).referenceForSpan(assertion.assertion_id, [start, start + phrase.length]) }],
  referents: [], frames: [{ id: "event", assertion_ids: [assertion.assertion_id],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [],
    predicate_support: { kind: "explicit" as const, reading, mentions: ["statement"] }, slots: [], bindings: [] }],
  operators: [], gaps: [] };
}

async function publish(session: Session, context: Context, original: string, phrase: string, reading: string) {
  const prepared = await prepareSource(session, context);
  const result = await output(session, context, { operation: "propose", source_handle: prepared.handle,
    generation_task: task(original), draft: draft(prepared.catalog, phrase, reading),
    producer_id: "authored-conditional-control", producer_version: "1", contract_version: "source-interpretation-v4" });
  if (result.operation !== "propose" || result.published === undefined) throw new Error("published H required");
  expect(result.published.interpretation.generation_task).toEqual(task(original));
  return result.published;
}

function correspondence(bound: SourceSemanticPublishedInterpretation, query: SourceSemanticQuery, alternative: number,
  excerpt: string): SourceSemanticCorrespondence {
  return { contract: "source-semantic-correspondence-v3", source_interpretation_id: bound.interpretation_id,
    query_semantics_id: sourceSemanticQueryIdentity(query, fieldContractSha256),
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [{ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative, frame: "qStatement" },
      source_endpoint: { kind: "frame", frame: "event" }, query_support: { kind: "query_text", excerpt },
      source_semantic_support: [{ kind: "lexical", mentions: ["statement"] }] }] };
}

async function prepareQuery(session: Session, context: Context, original: string, query: SourceSemanticQuery) {
  const result = await output(session, context, { operation: "prepare_query", original_query: original, query_semantics: query });
  if (result.operation !== "prepare_query" || result.query_handle === undefined) throw new Error("fresh query handle required");
  return result;
}

async function recall(session: Session, context: Context, original: string, query: SourceSemanticQuery,
  correspondences: readonly SourceSemanticCorrespondence[]) {
  const result = await output(session, context, { operation: "recall", accepts_unreviewed_conditional_results: true,
    original_query: original, query_semantics: query, semantic_correspondences: correspondences, output_byte_limit: 1_000_000 });
  if (result.operation !== "recall") throw new Error("recall required");
  const trusted = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
  const trust = session.proofRequests.trust(result.delivery_id!, session.stores.getStoredRecord(WS, trusted.identity));
  historicalTrust.set(result, trust);
  for (const qualifier of result.slot_qualifiers ?? []) {
    if (qualifier.evidence_kind !== "semantic_proof") continue;
    const entry = result.index!.entries[qualifier.index]!;
    // Core's delivered-proof verifier re-executes the accepting witness. The field page
    // binds the proof as side evidence, but the verifier must accept that result version
    // before this boundary is proved; binding presence alone is not verification.
    const verified = deliveredSourceSemanticLibraryProof(result.index!, entry, qualifier,
      result.proofs!, trusted, BUDGET, trust);
    expect(verified.proof).toBeDefined();
    expect(verified.proof).toMatchObject({ semantic_status: "unreviewed", world_claim: "unknown",
      conclusion_scope: "conditional_on_interpretation" });
    session.trace.push({ boundary: "consumer_proof_verification", value: { context,
      source_interpretation_id: verified.proof!.source_interpretation_id,
      query_semantics_id: verified.proof!.query_semantics_id,
      semantic_correspondence_id: verified.proof!.semantic_correspondence_id } });
  }
  return result;
}

const historicalTrust = new WeakMap<object, ReturnType<Session["proofRequests"]["trust"]>>();

function publications(session: Session, phase: string) {
  const rows = session.database.connection.prepare(`SELECT object_id, lifecycle_state, gist FROM evidence_capsules
    WHERE workspace_id = ? AND json_valid(gist) AND json_extract(gist, '$.contract') = 'published-source-interpretation-v5'
    ORDER BY object_id`).all(WS) as { object_id: string; lifecycle_state: string; gist: string }[];
  const bound = rows.map(row => ({ object_id: row.object_id, lifecycle_state: row.lifecycle_state,
    published: JSON.parse(row.gist) as SourceSemanticPublishedInterpretation }));
  session.trace.push({ boundary: "durable_publications", value: { phase, count: bound.length, rows: bound } });
  return bound;
}

function expectProofs(result: Awaited<ReturnType<typeof recall>>, ids: readonly string[]) {
  expect(result.proofs?.map(proof => proof.source_interpretation_id).sort()).toEqual([...ids].sort());
  expect(result.slot_qualifiers?.filter(row => row.evidence_kind === "semantic_proof")).toHaveLength(ids.length);
}

it("reuses task-scoped meaning across tasks, supplements omitted meaning and withdraws wrong support in both tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-cross-task-"));
  const trace: Trace = [{ boundary: "control_scope", value: { source: SOURCE, task_a: TASK_A, task_b: TASK_B,
    meaning_origin: "authored_conditional_control", ingestion: "audited_source_admission", natural_model_success: false } }];
  const fetchGuard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider calls are forbidden in this control"));
  let session: Session | undefined;
  let passed = false;
  try {
    session = await openSession(join(directory, "alaya.db"), trace);
    await session.admission.admit({ workspace_id: WS, source_id: SOURCE_ID, source_version: "1", content_bytes: SOURCE,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE) }, { workspaceId: WS });
    // Library membership is the accepted native source-index generation, as at daemon startup.
    await publishIndexedGeneration(session.database, [{ text: SOURCE }]);
    const { a, b } = queries();
    const good = await publish(session, CONTEXT_A, TASK_A, "Typecheck passed", "typecheck passed");
    const wrong = await publish(session, CONTEXT_A, TASK_A, "Typecheck passed", "typecheck failed");
    const aCs = [good, wrong].map(h => correspondence(h, a, 0, "typecheck passed"));
    const beforeA = await recall(session, CONTEXT_A, TASK_A, a, aCs);
    expectProofs(beforeA, [good.interpretation_id, wrong.interpretation_id]);
    const oldSource = await prepareSource(session, CONTEXT_A);
    const oldQuery = await prepareQuery(session, CONTEXT_A, TASK_A, a);
    const originalPublications = publications(session, "after_task_a");
    expect(originalPublications).toHaveLength(2);

    // A later principal/run gets new leases. Durable H keeps the original responsibility.
    expect(await call(session, CONTEXT_B, { operation: "reason", query_handle: oldQuery.query_handle,
      accepts_unreviewed_conditional_results: true, semantic_correspondence: aCs[0], output_byte_limit: 1_000_000 }))
      .toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: "VALIDATION" } } });
    await closeSession(session);
    session = undefined;
    session = await openSession(join(directory, "alaya.db"), trace);
    expect(await call(session, CONTEXT_B, { operation: "prepare_query", source_handle: oldSource.handle,
      original_query: TASK_B, query_semantics: b })).toMatchObject({ isError: true });
    const preparedB = await prepareQuery(session, CONTEXT_B, TASK_B, b);
    expect(preparedB.query_handle).not.toBe(oldQuery.query_handle);
    expect(preparedB.query_semantics_id).not.toBe(oldQuery.query_semantics_id);
    expect(preparedB.candidates.map(row => row.interpretation_id).sort())
      .toEqual([good.interpretation_id, wrong.interpretation_id].sort());
    expect(publications(session, "rediscovered_in_task_b")).toEqual(originalPublications);

    const bCs = [good, wrong].map(h => correspondence(h, b, 0, "type checking succeeded"));
    expect(sourceSemanticCorrespondenceIdentity(bCs[0]!, fieldContractSha256))
      .not.toBe(sourceSemanticCorrespondenceIdentity(aCs[0]!, fieldContractSha256));
    expect(await output(session, CONTEXT_B, { operation: "reason", source_interpretation_id: good.interpretation_id,
      accepts_unreviewed_conditional_results: true, original_query: TASK_B, query_semantics: b,
      semantic_correspondence: aCs[0], output_byte_limit: 1_000_000 }))
      .toMatchObject({ result: { outcome: { status: "invalid", reason: "malformed_correspondence" }, consumed_leaves: [] },
        coverage: { conditional_computation: "unexercised" } });
    const beforeB = await recall(session, CONTEXT_B, TASK_B, b, bCs);
    expectProofs(beforeB, [good.interpretation_id, wrong.interpretation_id]);
    expect(beforeB.proofs!.flatMap(proof => proof.binding_results ?? []).map(binding => binding.alternative)).toEqual([0, 0]);
    expect(beforeB.proofs!.find(proof => proof.source_interpretation_id === good.interpretation_id)?.interpretation)
      .toEqual(good.interpretation);
    expect(publications(session, "after_paraphrase_reuse")).toEqual(originalPublications);
    const raw = await recall(session, CONTEXT_B, TASK_B, b, []);
    expect(raw.proofs ?? []).toEqual([]);
    expect(JSON.stringify(raw.results)).toContain("Golden snapshot updated");

    const supplement = await publish(session, CONTEXT_B, TASK_B, "Golden snapshot updated", "golden snapshot updated");
    expect(supplement.interpretation_id).not.toBe(good.interpretation_id);
    const snapshotC = correspondence(supplement, b, 1, "golden snapshot was refreshed");
    const supplemented = await recall(session, CONTEXT_B, TASK_B, b, [...bCs, snapshotC]);
    expectProofs(supplemented, [good.interpretation_id, wrong.interpretation_id, supplement.interpretation_id]);
    expect(supplemented.proofs!.find(proof => proof.source_interpretation_id === supplement.interpretation_id)
      ?.binding_results?.map(binding => binding.alternative)).toEqual([1]);
    const afterSupplement = publications(session, "after_explicit_supplement");
    expect(afterSupplement).toHaveLength(3);
    expect(afterSupplement.find(row => row.published.interpretation_id === good.interpretation_id))
      .toEqual(originalPublications.find(row => row.published.interpretation_id === good.interpretation_id));

    const freshSource = await prepareSource(session, CONTEXT_B);
    expect(await output(session, CONTEXT_B, { operation: "invalidate", source_handle: freshSource.handle,
      source_interpretation_id: wrong.interpretation_id, reporter_id: "authored-source-review",
      error_basis: { reason: "The source says Typecheck passed; the failed reading is incorrect.", basis_ref: "original-validation-observation" } }))
      .toMatchObject({ invalidation: { status: "invalidated", source_interpretation_id: wrong.interpretation_id } });
    const afterA = await recall(session, CONTEXT_A, TASK_A, a, aCs);
    const afterB = await recall(session, CONTEXT_B, TASK_B, b, [...bCs, snapshotC]);
    expectProofs(afterA, [good.interpretation_id]);
    expectProofs(afterB, [good.interpretation_id, supplement.interpretation_id]);
    for (const historical of [beforeA, beforeB]) {
      const qualifier = historical.slot_qualifiers!.find(row => row.source_interpretation_id === wrong.interpretation_id)!;
      // A historical derivation stays inspectable only when the verifier can reproduce it.
      expect(deliveredSourceSemanticLibraryProof(historical.index!, historical.index!.entries[qualifier.index]!, qualifier,
        historical.proofs!, session.stores.getCurrentRecord(WS, SOURCE_ID)!, BUDGET,
        historicalTrust.get(historical)!).proof).toBeDefined();
      trace.push({ boundary: "historical_proof_verification_after_withdrawal", value: {
        source_interpretation_id: wrong.interpretation_id, query_semantics_id: qualifier.query_semantics_id,
        current_eligibility: false, historical_derivation_verified: true } });
    }
    const finalRows = publications(session, "after_cross_task_withdrawal");
    expect(finalRows).toHaveLength(3);
    expect(finalRows.filter(row => row.lifecycle_state === "active").map(row => row.published.interpretation_id).sort())
      .toEqual([good.interpretation_id, supplement.interpretation_id].sort());
    const currentSource = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    expect(session.stores.getStoredRecord(WS, currentSource.identity)?.content_bytes).toBe(SOURCE);
    expect(session.database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    expect(fetchGuard).not.toHaveBeenCalled();
    passed = true;
  } finally {
    trace.push({ boundary: "completion", value: { passed, fetch_attempts: fetchGuard.mock.calls.length } });
    fetchGuard.mockRestore();
    if (session !== undefined) await closeSession(session);
    await rm(directory, { recursive: true, force: true });
    const tracePath = process.env.ALAYA_CROSS_TASK_TRACE_PATH;
    if (tracePath !== undefined) await writeFile(tracePath, JSON.stringify(trace, null, 2), { encoding: "utf8", flag: "wx" });
  }
}, 30_000);
