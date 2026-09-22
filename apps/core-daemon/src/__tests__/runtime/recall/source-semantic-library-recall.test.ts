import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Core from "@do-soul/alaya-core";
import {
  buildSourceReferenceCatalog, canonicalProductIdentityOfEntry, SOURCE_SEMANTIC_K_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SOURCE_SEMANTIC_PUBLISHED_CONTRACT, sourceReferenceResolver,
  type SourceEvidenceTarget,
  type SourceReferenceCatalog, type SourceSemanticCorrespondence, type SourceSemanticQuery,
  type SourceSemanticWorkerResult, type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticQuery, createAuditedSourceAdmission, createSourceSemanticInterpretationPublication,
  EvidenceService, encodeSourceSemanticLibraryResponse, fieldContractSha256, preparedDeliveryId, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget, listEligibleSemanticSources } from "../../../runtime/field/source-semantic-read-stores.js";
import { runSourceSemanticLibraryRecall } from "../../../runtime/recall-read-worker/source-semantic-library-recall.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { createRecallReadWorkerClient, type RecallReadWorkerClient }
  from "../../../runtime/recall/recall-read-worker-client.js";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import {
  createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import {
  exposureSlots, firstExposureMismatch, FirstExposureSession
} from "../../../../../../apps/bench-runner/src/runs/measurement/first-exposure-session.js";
import {
  recordSourceSemanticLibraryFirstExposure, soulSearchFromLibraryRecall
} from "../../../../../../apps/bench-runner/src/runs/measurement/source-semantic-library-recall.js";
import {
  measureSourceSemanticLibraryResponse
} from "../../../../../../apps/bench-runner/src/runs/measurement/source-semantic-library-measurement.js";
import { sourceGoldUnitFromPublishedRoot } from "../../../../../../apps/bench-runner/src/runs/measurement/source-gold-join.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const SOURCE = `User: ${ASSERTION}`;
const FAILED_SOURCE = "User: Bob stays silent.";
const ORIGINAL = "which tools does Alice use?";
const BUDGET = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};

type Execute = NonNullable<RecallReadWorkerClient["sourceSemanticsPort"]>["execute"];

function catalogFor(text: string): SourceReferenceCatalog {
  return buildSourceReferenceCatalog(fieldContractSha256(text), [{ assertion_id: 1, text }], fieldContractSha256);
}

function usesDraft(catalog: SourceReferenceCatalog, assertion: string) {
  const references = sourceReferenceResolver(catalog, fieldContractSha256);
  const sourceRef = (text: string) => references.referenceForSpan(1, [
    assertion.indexOf(text), assertion.indexOf(text) + text.length
  ]);
  return {
    contract: "source-interpretation-v4" as const,
    mentions: [
      { id: "mAlice", assertion_id: 1, source_ref: sourceRef("Alice") },
      { id: "mUses", assertion_id: 1, source_ref: sourceRef("uses") },
      { id: "mTools", assertion_id: 1, source_ref: sourceRef("tools") }
    ],
    referents: [
      { id: "rAlice", referent_kind: "grouped" as const, mentions: ["mAlice"] },
      { id: "rTools", referent_kind: "grouped" as const, mentions: ["mTools"] }
    ],
    frames: [{
      id: "fUse", assertion_ids: [1],
      context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
      additional_support: [],
      predicate_support: { kind: "explicit" as const, reading: "use", mentions: ["mUses"] },
      slots: [
        { id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["mAlice"] }] },
        { id: "theme", role_reading: "theme", support: [{ kind: "lexical" as const, mentions: ["mTools"] }] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node" as const, id: "rAlice" }, support: [] },
        { slot_id: "theme", target: { kind: "node" as const, id: "rTools" }, support: [] }
      ]
    }],
    operators: [],
    gaps: []
  };
}

function queryOf(): SourceSemanticQuery {
  return {
    contract: "source-semantic-query-v2",
    original_query_digest: digestOriginalQuery(ORIGINAL),
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v2",
    variables: [{ id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } }, { id: "tools", sort: "entity" }, { id: "fUse", sort: "proposition" }],
    alternatives: [{
      frames: [{
        id: "qUse", variable: "fUse", predicate_reading: "use",
        role_requirements: [{ id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: "Alice" } }, {
          id: "theme", role_reading: "theme", target_variable: "tools",
          support: { kind: "query_text", excerpt: "tools" }
        }]
      }],
      context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }]
    }],
    return_variables: ["tools"],
    gaps: []
  };
}

function alignmentOf(hId: string, q: SourceSemanticQuery): SourceSemanticCorrespondence {
  const admitted = admitSourceSemanticQuery(q, ORIGINAL);
  if (admitted.kind !== "admitted") throw new Error("query must admit");
  return {
    contract: "source-semantic-correspondence-v3",
    source_interpretation_id: hId, query_semantics_id: admitted.query_id,
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
    producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [
      { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
        source_endpoint: { kind: "referent", referent: "rAlice" }, query_support: { kind: "query_text", excerpt: "Alice" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "agent" },
        source_endpoint: { kind: "slot", frame: "fUse", slot: "agent" }, query_support: { kind: "query_text", excerpt: "Alice" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
        source_endpoint: { kind: "frame", frame: "fUse" }, query_support: { kind: "query_text", excerpt: "use" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mUses"] }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "theme" },
        source_endpoint: { kind: "slot", frame: "fUse", slot: "theme" }, query_support: { kind: "query_text", excerpt: "tools" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mTools"] }] }
    ]
  };
}

async function withLibrary(body: (input: {
  allIds: readonly string[]; execute: Execute; filename: string;
  sourceTarget: SourceEvidenceTarget;
}) => Promise<void>, count: number) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-library-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const evidenceService = new EvidenceService({
    eventLogRepo, runtimeNotifier, evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK
  });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  await admission.admit({
    workspace_id: WS, source_id: "artifact-1", source_version: "1", content_bytes: SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  await admission.admit({
    workspace_id: WS, source_id: "artifact-failed", source_version: "1", content_bytes: FAILED_SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(FAILED_SOURCE)
  }, { workspaceId: WS });
  const catalog = catalogFor(ASSERTION);
  const allIds: string[] = [];
  let sourceTarget: SourceEvidenceTarget | undefined;
  for (let index = 0; index < count; index += 1) {
    const published = await createSourceSemanticInterpretationPublication({
      stores, evidenceService, sha256: fieldContractSha256
    }).publish({
      workspaceId: WS, runId: RUN, artifactKey: "artifact-1", source: SOURCE, catalog,
      provenance: { producer_id: "test-author" }, draft: usesDraft(catalog, ASSERTION),
      producer_version: `p${String(index + 1)}`, contract_version: "source-interpretation-v4"
    });
    allIds.push(published.bound.interpretation_id);
    sourceTarget = published.bound.source_target;
  }
  if (sourceTarget === undefined) throw new Error("published source target expected");
  expect(database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
  database.close(); closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    await client.ready();
    await body({ allIds, execute: (input) => client.sourceSemanticsPort!.execute(input), filename, sourceTarget });
  } finally {
    await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  }
}

async function call<K extends SourceSemanticWorkerRequest["kind"]>(execute: Execute, request: Extract<SourceSemanticWorkerRequest, { kind: K }>) {
  const result = await execute({
    workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request
  });
  if (result.kind !== request.kind) throw new Error("worker operation mismatch");
  return result as Extract<SourceSemanticWorkerResult, { kind: K }>;
}

function recallRequest(semantic_correspondences: readonly SourceSemanticCorrespondence[]): Extract<SourceSemanticWorkerRequest, { kind: "recall" }> {
  return {
    kind: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL, query_semantics: queryOf(),
    semantic_correspondences, budget: BUDGET, output_byte_limit: 1_000_000
  };
}

it("discovers a relevant interpretation after the first descriptor page and keeps a source without a source interpretation", async () => {
  await withLibrary(async ({ allIds, execute, filename }) => {
    const prepared = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    expect(prepared.kind).toBe("prepare_query");
    if (prepared.kind !== "prepare_query") throw new Error("query preparation expected");
    expect(prepared.candidates.length).toBe(16);
    expect(prepared.truncated).toBe(true);
    const gold = allIds.find((id) => !prepared.candidates.some((row) => row.interpretation_id === id));
    expect(gold).toBeDefined();
    const recalled = await call(execute, recallRequest([alignmentOf(gold!, queryOf())]));
    expect(recalled.kind).toBe("recall");
    if (recalled.kind !== "recall") throw new Error("library recall expected");
    expect(recalled.discovery.visited_source_interpretation_pages).toBeGreaterThanOrEqual(2);
    expect(recalled.discovery.visited_source_interpretation_descriptors).toBeGreaterThan(16);
    expect(recalled.discovery.examined_source_interpretation_ids).toEqual([gold]);
    expect(recalled.discovery.unexamined_source_interpretation_count).toBeGreaterThan(0);
    expect(recalled.discovery.eligible_source_count).toBeGreaterThanOrEqual(2);
    expect(recalled.order.enumeration_policy).toBe("canonical");
    expect(recalled.order.occupancy).toBe("source_gold_root_identity");
    const search = soulSearchFromLibraryRecall(recalled);
    const roots = search.results.slice(0, 5).map((row) => row.target.kind === "source_evidence"
      ? sourceGoldRootIdentity(row.target) : row.object_id ?? "");
    expect(new Set(roots).size).toBe(roots.length);
    expect(search.results.some((row) => row.content_preview?.includes("Bob stays silent.")
      && row.object_kind === "source_evidence")).toBe(true);
    expect(search.results.some((row) => row.object_kind === "memory_entry")).toBe(false);
    expect(recalled.slot_qualifiers.some((row) => row.evidence_kind === "semantic_proof" && row.source_interpretation_id === gold)).toBe(true);
    const proofIndex = recalled.slot_qualifiers.find((row) => row.evidence_kind === "semantic_proof" && row.source_interpretation_id === gold)!.index;
    expect(search.results[proofIndex]?.object_kind).toBe("semantic_proof");
    const page = recordSourceSemanticLibraryFirstExposure(recalled);
    expect(page.initial?.slots[proofIndex]?.object_kind).toBe("semantic_proof");
    expect(firstExposureMismatch(page, {
      query_id: search.index!.query_id, snapshot_id: search.index!.snapshot_id,
      interpretation_id: search.index!.interpretation_id!, as_of: search.index!.as_of!
    }, exposureSlots(search), search.delivery_id)).toBe(false);
    const again = soulSearchFromLibraryRecall(await call(execute, recallRequest([alignmentOf(gold!, queryOf())])));
    expect(again.results.map((row) => row.target)).toEqual(search.results.map((row) => row.target));
    const { database } = await createRecallRealStorage(() => undefined, filename);
    expect(database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    database.close(); closeCachedDatabase(filename);
  }, 20);
}, 60000);

it("examines aligned handles without hydrating every published descriptor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-library-identity-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const evidenceService = new EvidenceService({
    eventLogRepo, runtimeNotifier, evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK
  });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  await admission.admit({
    workspace_id: WS, source_id: "artifact-1", source_version: "1", content_bytes: SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  const catalog = catalogFor(ASSERTION);
  const published = await createSourceSemanticInterpretationPublication({
    stores, evidenceService, sha256: fieldContractSha256
  }).publish({
    workspaceId: WS, runId: RUN, artifactKey: "artifact-1", source: SOURCE, catalog,
    provenance: { producer_id: "test-author" }, draft: usesDraft(catalog, ASSERTION),
    producer_version: "p1", contract_version: "source-interpretation-v4"
  });
  const source = published.bound.interpretation.source;
  for (let index = 0; index < 19; index += 1) {
    database.connection.prepare(`
      INSERT INTO evidence_capsules (
        object_id, created_at, updated_at, created_by, evidence_kind, semantic_anchor,
        gist, excerpt, run_id, workspace_id
      ) VALUES (?, ?, ?, 'test', 'conversation_excerpt', '{}', ?, ?, ?, ?)
    `).run(
      `capsule-${String(index).padStart(2, "0")}`, CLOCK, CLOCK,
      JSON.stringify({
        contract: SOURCE_SEMANTIC_PUBLISHED_CONTRACT,
        interpretation_id: `sha256:${fieldContractSha256(`identity-h-${String(index)}`)}`,
        interpretation: {
          k_version: SOURCE_SEMANTIC_K_VERSION, producer_id: "test-author",
          producer_version: `p${String(index + 2)}`, contract_version: "source-interpretation-v4",
          source: {
            source_id: source.source_id, source_version: source.source_version, content_digest: source.content_digest
          }
        }
      }),
      "identity", RUN, WS
    );
  }
  const hydrate = vi.spyOn(SqliteSourceHintReader.prototype, "readBoundInterpretation");
  try {
    const recalled = runSourceSemanticLibraryRecall(
      { database } as RecallReadWorkerRuntime,
      {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
        request: recallRequest([alignmentOf(published.bound.interpretation_id, queryOf())])
      },
      ["project"],
      new SourceSemanticReadBudget(BUDGET)
    );
    expect(recalled.kind).toBe("recall");
    if (recalled.kind !== "recall") throw new Error("library recall expected");
    expect(recalled.discovery.visited_source_interpretation_descriptors).toBe(20);
    expect(recalled.discovery.visited_source_interpretation_pages).toBeGreaterThanOrEqual(2);
    expect(recalled.discovery.examined_source_interpretation_ids).toEqual([published.bound.interpretation_id]);
    expect(hydrate).toHaveBeenCalledTimes(1);
    const executeBranch = Core.executeSourceSemanticInterpretation;
    const partial = vi.spyOn(Core, "executeSourceSemanticInterpretation").mockImplementation((input) => {
      const actual = executeBranch(input);
      return { ...actual, result: { ...actual.result, outcome: { status: "resource_exhausted" } } };
    });
    try {
      const incomplete = runSourceSemanticLibraryRecall({ database } as RecallReadWorkerRuntime, {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
        request: recallRequest([alignmentOf(published.bound.interpretation_id, queryOf())])
      }, ["project"], new SourceSemanticReadBudget(BUDGET));
      if (incomplete.kind !== "recall") throw new Error("library recall expected");
      expect(incomplete.proofs?.[0]?.answers?.length).toBeGreaterThan(0);
      expect(incomplete.coverage.conditional_computation).toBe("open");
      expect(incomplete.discovery.open_residuals).toBe(true);
    } finally { partial.mockRestore(); }
  } finally {
    hydrate.mockRestore();
    database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  }
});

it("drops a conditional proof when A is absent and still returns the original source", async () => {
  await withLibrary(async ({ execute }) => {
    const withProof = await call(execute, recallRequest([alignmentOf(
      (await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET })).candidates[0]!.interpretation_id,
      queryOf()
    )]));
    const without = await call(execute, recallRequest([]));
    expect(withProof.kind).toBe("recall");
    expect(without.kind).toBe("recall");
    if (withProof.kind !== "recall" || without.kind !== "recall") throw new Error("library recall expected");
    expect(withProof.slot_qualifiers.some((row) => row.evidence_kind === "semantic_proof")).toBe(true);
    expect(without.slot_qualifiers.some((row) => row.evidence_kind === "semantic_proof")).toBe(false);
    expect(without.discovery.examined_source_interpretation_ids).toEqual([]);
    const search = soulSearchFromLibraryRecall(without);
    expect(search.results.some((row) => row.content_preview?.includes("Alice uses tools."))).toBe(true);
    expect(search.results.some((row) => row.content_preview?.includes("Bob stays silent."))).toBe(true);
  }, 3);
});

it("keeps excluded source interpretation identities out of public discovery diagnostics", async () => {
  await withLibrary(async ({ execute, filename, allIds }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    database.connection.prepare("UPDATE source_records SET scope_class = 'global_core' WHERE source_id = 'artifact-1'").run();
    database.close(); closeCachedDatabase(filename);
    const recalled = await call(execute, recallRequest([alignmentOf(allIds[0]!, queryOf())]));
    expect(recalled.discovery).toMatchObject({ eligible_source_count: 1, candidate_prefix: [],
      visited_source_interpretation_descriptors: 0, unexamined_source_interpretation_count: 0, examined_source_interpretation_ids: [] });
    expect(recalled.proofs).toBeUndefined();
    expect(soulSearchFromLibraryRecall(recalled).results[0]?.content_preview).toContain("Bob stays silent.");
  }, 1);
});

it("scores mixed-kind retrieval and proof-conditioned Any@K from one published source interpretation", async () => {
  await withLibrary(async ({ allIds, execute, sourceTarget }) => {
    const gold = sourceGoldUnitFromPublishedRoot(sourceTarget);
    expect(gold.root_id).toBe(sourceTarget.root_id);
    const withA = await call(execute, recallRequest([alignmentOf(allIds[0]!, queryOf())]));
    const withoutA = await call(execute, recallRequest([]));
    expect(withA.kind).toBe("recall");
    expect(withoutA.kind).toBe("recall");
    if (withA.kind !== "recall" || withoutA.kind !== "recall") throw new Error("library recall expected");
    const proof = measureSourceSemanticLibraryResponse({
      recallResult: withA, firstExposurePage: recordSourceSemanticLibraryFirstExposure(withA),
      requestBudget: BUDGET, goldSourceUnits: [gold]
    });
    const retrieval = measureSourceSemanticLibraryResponse({
      recallResult: withoutA, firstExposurePage: recordSourceSemanticLibraryFirstExposure(withoutA),
      requestBudget: BUDGET, goldSourceUnits: [gold]
    });
    expect(proof).toMatchObject({
      status: "validated", provider_calls: 0,
      request: { budget: { page_budget: BUDGET.page_budget } },
      metrics: {
        mixed_kind_first_exposure: { any_at_10: { status: "miss", value: false } },
        proof_conditioned_first_exposure: { any_at_10: { status: "hit", value: true } }
      }
    });
    const changedDigest = `sha256:${"ef".repeat(32)}`;
    const tampered = [
      { ...withA, proofs: [] },
      { ...withA, proofs: withA.proofs?.map((row) => ({ ...row, outcome: { status: "invalid" as const, reason: "rejected" } })) },
      { ...withA, proofs: withA.proofs?.map((row) => ({ ...row, evidence_leaves: row.evidence_leaves?.slice(1) })) },
      { ...withA, proofs: withA.proofs?.map((row) => ({ ...row, consumed_leaves: [] })) },
      { ...withA, proofs: withA.proofs?.map((row) => ({ ...row, context: { ...row.context, semantic_correspondence_id: changedDigest } })) },
      { ...withA, slot_qualifiers: withA.slot_qualifiers.map((row) => row.evidence_kind === "semantic_proof" ? { ...row, conditional_computation_id: changedDigest } : row) },
      { ...withA, index: { ...withA.index, query_id: changedDigest } },
      { ...withA, index: { ...withA.index, entries: withA.index.entries.map((entry) => entry.interpretation_node === undefined ? entry
        : { ...entry, target: { ...sourceTarget, source_version: "2", content_digest: changedDigest } }) },
        proofs: withA.proofs?.map((row) => ({ ...row, source_target: { ...sourceTarget, source_version: "2", content_digest: changedDigest } })) }
    ];
    for (const response of tampered) {
      const measured = measureSourceSemanticLibraryResponse({ recallResult: response,
        firstExposurePage: recordSourceSemanticLibraryFirstExposure(response), requestBudget: BUDGET, goldSourceUnits: [gold] });
      expect(measured).toMatchObject({ status: "validated",
        metrics: { proof_conditioned_first_exposure: { any_at_10: { status: "unavailable", value: null } } } });
      if (measured?.status !== "validated") throw new Error("mixed source measurement missing");
      expect(measured.metrics.mixed_kind_first_exposure.any_at_10.status).not.toBe("unavailable");
    }
    expect(measureSourceSemanticLibraryResponse({ recallResult: withA,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(withA), requestBudget: { ...BUDGET, work_units: 1 },
      goldSourceUnits: [gold] })).toMatchObject({ status: "invalid", reason: "request_budget_mismatch" });
    expect(retrieval).toMatchObject({
      status: "validated", provider_calls: 0,
      request: { budget: { page_budget: BUDGET.page_budget } },
      metrics: {
        mixed_kind_first_exposure: { any_at_10: { status: "hit", value: true } },
        proof_conditioned_first_exposure: { any_at_10: { status: "miss", value: false } }
      }
    });
    expect(proof && "request" in proof ? "execution_receipt" in proof.request : true).toBe(false);
    expect(BUDGET.page_budget).not.toBe(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
    expect(retrieval && "metrics" in retrieval ? retrieval.metrics.mixed_kind_first_exposure.any_at_10 : null)
      .not.toEqual(retrieval && "metrics" in retrieval
        ? retrieval.metrics.proof_conditioned_first_exposure.any_at_10 : undefined);
  }, 1);
});

it.each([2001, 70000])("reports shortened %i-character source previews in both public coverage fields", async (length) => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-library-long-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  const long = "x".repeat(length);
  await admission.admit({
    workspace_id: WS, source_id: "artifact-long", source_version: "1", content_bytes: long,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(long)
  }, { workspaceId: WS });
  database.close(); closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    await client.ready();
    const recalled = await call((input) => client.sourceSemanticsPort!.execute(input), recallRequest([]));
    expect(recalled.kind).toBe("recall");
    if (recalled.kind !== "recall") throw new Error("library recall expected");
    const publicResult = encodeSourceSemanticLibraryResponse(recalled);
    if (publicResult.operation !== "recall") throw new Error("public recall expected");
    expect(publicResult.coverage.payload).toBe("truncated");
    expect(publicResult.index?.completeness.payload).toBe("partial");
    expect(publicResult.results?.[0]?.content_preview).toHaveLength(2000);
    const capped = await call((input) => client.sourceSemanticsPort!.execute(input), { ...recallRequest([]), output_byte_limit: 4096 });
    expect(Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(capped)))).toBeLessThanOrEqual(4096);
    const preview = Object.values(recalled.previews ?? {})[0] ?? "";
    expect(preview.length).toBeLessThanOrEqual(4_096);
    expect(preview.length).toBeGreaterThan(0);
  } finally {
    await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  }
});

it("prepares multi-sentence sources with packing units instead of one whole-body assertion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-library-units-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  const source = "Alice uses tools. Extra clause remains.";
  await admission.admit({
    workspace_id: WS, source_id: "artifact-multi", source_version: "1", content_bytes: source,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(source)
  }, { workspaceId: WS });
  database.close(); closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    await client.ready();
    const prepared = await call((input) => client.sourceSemanticsPort!.execute(input), {
      kind: "prepare_source", source_id: "artifact-multi", budget: BUDGET
    });
    expect(prepared.kind).toBe("prepare_source");
    if (prepared.kind !== "prepare_source") throw new Error("source preparation expected");
    expect(prepared.catalog.assertions.map((row) => row.assertion_id)).toEqual([1, 2]);
  } finally {
    await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  }
});

it("binds delivery_id to the delivered first-exposure membership", async () => {
  await withLibrary(async ({ allIds, execute }) => {
    const semantic_correspondences = [alignmentOf(allIds[0]!, queryOf())];
    const full = await call(execute, { ...recallRequest(semantic_correspondences), output_byte_limit: 1_000_000 });
    expect(full.kind).toBe("recall");
    if (full.kind !== "recall") throw new Error("library recall expected");
    let limited: typeof full | undefined;
    for (const limit of [1024, 2048, 4096, 8192, 16384]) {
      try {
        const result = await call(execute, { ...recallRequest(semantic_correspondences), output_byte_limit: limit });
        if (result.kind === "recall" && result.proofs === undefined) { limited = result; break; }
      } catch { /* output_byte_limit below the demoted envelope */ }
    }
    if (limited === undefined) {
      const shortened = { ...full.index, entries: full.index.entries.slice(0, Math.max(0, full.index.entries.length - 1)) };
      expect(preparedDeliveryId("same-digest", full.index))
        .not.toBe(preparedDeliveryId("same-digest", shortened));
      return;
    }
    expect(limited.delivery_id).not.toBe(full.delivery_id);
    expect(JSON.stringify(exposureSlots(soulSearchFromLibraryRecall(full))))
      .not.toBe(JSON.stringify(exposureSlots(soulSearchFromLibraryRecall(limited))));
  }, 1);
});

it("expires preparation by elapsed lifetime while retaining a fixed interpretation clock", async () => {
  await withLibrary(async ({ execute }) => {
    let now = "2026-09-21T00:00:00.000Z";
    const handler = createSourceSemanticInterpretationHandler({ now: () => now,
      interpretationClock: CLOCK, sourceSemanticsPort: { execute } });
    const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "fixed-clock" };
    const prepared = await handler({ operation: "prepare_source", source_id: "artifact-1", budget: BUDGET }, context);
    if (prepared.operation !== "prepare_source" || prepared.source_handle === undefined) throw new Error("preparation missing");
    const request = { operation: "prepare_query" as const, original_query: ORIGINAL, query_semantics: queryOf(),
      source_handle: prepared.source_handle, budget: BUDGET };
    now = "2026-09-21T00:01:00.000Z";
    expect((await handler(request, context)).operation).toBe("prepare_query");
    now = "2026-09-21T00:11:00.000Z";
    await expect(handler(request, context)).rejects.toThrow(/expired/u);
  }, 1);
});

it("pages library occupancy without duplicating first-page product identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-library-pages-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  for (let index = 0; index < 12; index += 1) {
    const source = `User: source ${String(index)}.`;
    await admission.admit({
      workspace_id: WS, source_id: `artifact-${String(index)}`, source_version: "1", content_bytes: source,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(source)
    }, { workspaceId: WS });
  }
  database.close(); closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    await client.ready();
    const execute: Execute = (input) => client.sourceSemanticsPort!.execute(input);
    const first = await call(execute, recallRequest([]));
    expect(first.kind).toBe("recall");
    if (first.kind !== "recall") throw new Error("library recall expected");
    expect(first.index.entries).toHaveLength(10);
    expect(first.index.continuation).not.toBeNull();
    const second = await execute({ workspace_id: WS, as_of: "2026-09-18T00:00:00.001Z",
      authorized_scopes: { mode: "named", scopes: ["project"] },
      request: { ...recallRequest([]), continuation: first.index.continuation! } });
    expect(second.kind).toBe("recall");
    if (second.kind !== "recall") throw new Error("library recall expected");
    expect(second.index.entries.length).toBeGreaterThan(0);
    expect(second.index.as_of).toBe(first.index.as_of);
    const exposureSession = new FirstExposureSession();
    const firstExposure = recordSourceSemanticLibraryFirstExposure(first, exposureSession);
    const nextExposure = recordSourceSemanticLibraryFirstExposure(second, exposureSession, first.index.continuation);
    expect(nextExposure.initial).toEqual(firstExposure.initial);
    expect(recordSourceSemanticLibraryFirstExposure(second, new FirstExposureSession(), first.index.continuation).initial).toBeNull();
    const continued = { ...recallRequest([]), continuation: first.index.continuation! };
    await expect(execute({ workspace_id: WS, as_of: "2026-09-18T00:06:00.000Z",
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: continued })).rejects.toThrow(/expired/u);
    // Use a new capability after testing expiry, which retires the old lease.
    let clock = CLOCK;
    const handler = createSourceSemanticInterpretationHandler({ now: () => clock, sourceSemanticsPort: { execute } });
    const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "page-session" };
    const { kind: _kind, ...base } = recallRequest([]);
    const publicRequest = { operation: "recall" as const, ...base, authorized_scopes: { mode: "named" as const, scopes: ["project"] } };
    const publicFirst = await handler(publicRequest, context);
    if (publicFirst.operation !== "recall" || publicFirst.index?.continuation == null) throw new Error("public page missing");
    clock = "2026-09-18T00:00:00.100Z";
    const nextRequest = { ...publicRequest, continuation: publicFirst.index.continuation };
    const publicNext = await handler(nextRequest, context);
    if (publicNext.operation !== "recall") throw new Error("public recall missing");
    expect(publicNext.index?.entries).toHaveLength(2);
    await expect(handler(nextRequest, { ...context, agentTarget: "other" })).rejects.toThrow(/principal/u);
    await expect(handler({ ...nextRequest, budget: { ...BUDGET, work_units: BUDGET.work_units - 1 } }, context)).rejects.toThrow(/changed/u);
    await expect(handler({ ...nextRequest, authorized_scopes: { mode: "named", scopes: ["global_core"] } }, context)).rejects.toThrow(/scope/u);
    const changed = await createRecallRealStorage(() => undefined, filename);
    changed.database.connection.prepare("UPDATE source_records SET scope_class = 'global_core' WHERE source_id = 'artifact-0'").run();
    changed.database.close(); closeCachedDatabase(filename);
    await expect(handler(nextRequest, context)).rejects.toThrow(/snapshot/u);
    let lifetime = "2026-09-21T00:00:00.000Z";
    const fixed = createSourceSemanticInterpretationHandler({ now: () => lifetime, interpretationClock: CLOCK,
      sourceSemanticsPort: { execute } });
    const fixedFirst = await fixed(publicRequest, context);
    if (fixedFirst.operation !== "recall" || fixedFirst.index?.continuation == null) throw new Error("fixed-clock page missing");
    expect(fixedFirst.index.as_of).toBe(CLOCK);
    expect(fixedFirst.index.continuation.expires_at).toBe("2026-09-21T00:05:00.000Z");
    const fixedRequest = { ...publicRequest, continuation: fixedFirst.index.continuation };
    lifetime = "2026-09-21T00:01:00.000Z";
    const fixedNext = await fixed(fixedRequest, context);
    if (fixedNext.operation !== "recall") throw new Error("fixed-clock continuation missing");
    expect(fixedNext.index?.as_of).toBe(CLOCK);
    lifetime = "2026-09-21T00:06:00.000Z";
    await expect(fixed(fixedRequest, context)).rejects.toThrow(/expired/u);
    const firstIds = new Set(first.index.entries.map(canonicalProductIdentityOfEntry));
    expect(second.index.entries.some((entry) => firstIds.has(canonicalProductIdentityOfEntry(entry)))).toBe(false);
    await expect(call(execute, {
      ...recallRequest([]),
      continuation: { ...first.index.continuation!, cursor: "offset-0" }
    })).rejects.toThrow(/continuation|expired/u);
  } finally {
    await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  }
});

it("withholds historical-prefix sources when a later supersession is excluded, erased or unavailable", async () => {
  const { database } = await createRecallRealStorage(() => undefined);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
  const admit = (id: string, version: string, at: string, scope: "project" | "global_core" = "project") => admission.admit({
    workspace_id: WS, source_id: id, source_version: version, content_bytes: `source ${id} ${version}`,
    evidence_object_id: null, recorded_at: at, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: scope, spans: []
  }, { workspaceId: WS });
  const read = () => listEligibleSemanticSources(database, WS, new SourceSemanticReadBudget(BUDGET), ["project"]);
  try {
    for (let i = 0; i < 512; i += 1) await admit(`source-${i}`, "1", CLOCK);
    const insufficient = new SourceSemanticReadBudget({ work_units: 79, memory_bytes: BUDGET.memory_bytes });
    expect(listEligibleSemanticSources(database, WS, insufficient, ["project"]))
      .toMatchObject({ sources: [], pages: 0, open: true, truncated: true });
    expect(insufficient.nativeWork).toBe(0);
    await admit("source-0", "2", "2026-09-19T00:00:00.000Z", "global_core");
    expect(read()).toMatchObject({ sources: [], open: true, truncated: true, pages: 32 });
    database.connection.prepare("UPDATE source_records SET source_body = NULL WHERE source_version = '2'").run();
    expect(read()).toMatchObject({ sources: [], open: true, truncated: true });
    // Bring the newest row inside the bounded scan, but make its retained body unavailable.
    database.connection.prepare("DELETE FROM source_records WHERE source_id NOT IN ('source-0', 'source-1')").run();
    database.connection.prepare("UPDATE source_records SET source_body = 'unavailable' WHERE source_version = '2'").run();
    database.connection.prepare("DELETE FROM retained_source_chunks WHERE source_revision = '2'").run();
    expect(read()).toMatchObject({ sources: [], open: true });
  } finally { database.close(); }
});
