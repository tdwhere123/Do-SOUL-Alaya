import { authoredQuerySemantics, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  buildSourceReferenceCatalog, hashLabeledIdentity, sourceReferenceResolver, canonicalJson,
  SourceSemanticPublishedInterpretationSchema, sourceSemanticInterpretationIdentity,
  type SourceReferenceCatalog, type SourceSemanticCorrespondence, type SourceSemanticQuery,
  type SourceSemanticWorkerRequest,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT
} from "@do-soul/alaya-protocol";
import { proposeCorrespondenceSemantics, proposeQuerySemantics } from "@do-soul/alaya-soul";
import {
  admitSourceSemanticQuery, createAuditedSourceAdmission, createSourceSemanticInterpretationPublication,
  EvidenceService, fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, semanticInterpretationEvidenceId
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteFieldEraseBarrierRepo }
  from "@do-soul/alaya-storage";
import { parseWorkerOperationPayload } from "../../../runtime/recall-read-worker/operation-schemas.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient, type RecallReadWorkerClient }
  from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import {
  createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const SOURCE = `User: ${ASSERTION}`;
const ORIGINAL = "which tools does Alice use?";
const BUDGET = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};

const ALICE_CORRESPONDENCES: import("@do-soul/alaya-protocol").SourceSemanticCorrespondence["correspondences"] = [
  { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
    source_endpoint: { kind: "referent", referent: "rAlice" }, query_support: { kind: "query_text", excerpt: "Alice" }, source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] },
  { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "agent" },
    source_endpoint: { kind: "slot", frame: "fUse", slot: "agent" }, query_support: { kind: "query_text", excerpt: "Alice" }, source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] }
];

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
      ...ALICE_CORRESPONDENCES,
      {
        relation: "contextual_equivalence",
        query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
        source_endpoint: { kind: "frame", frame: "fUse" },
        query_support: { kind: "query_text", excerpt: "use" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mUses"] }]
      },
      {
        relation: "contextual_equivalence",
        query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "theme" },
        source_endpoint: { kind: "slot", frame: "fUse", slot: "theme" },
        query_support: { kind: "query_text", excerpt: "tools" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mTools"] }]
      }
    ]
  };
}

async function withPublished(body: (input: {
  hId: string; allIds: readonly string[]; execute: Execute; filename: string; client: RecallReadWorkerClient;
}) => Promise<void>, options: Readonly<{
  valid_from?: string; valid_to?: string; state?: "erased" | "superseded";
  scope?: "project" | "global_core"; count?: number; large?: boolean;
}> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-reasoning-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const evidenceService = new EvidenceService({
    eventLogRepo, runtimeNotifier, evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK
  });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  const admitted = await admission.admit({
    workspace_id: WS, source_id: "artifact-1", source_version: "1", content_bytes: SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null,
    valid_from: options.valid_from ?? null, valid_to: options.valid_to ?? null,
    speaker: "user", scope_class: options.scope ?? "project", spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  const catalog = catalogFor(ASSERTION);
  const published = await createSourceSemanticInterpretationPublication({
    stores, evidenceService, sha256: fieldContractSha256
  }).publish({
    workspaceId: WS, runId: RUN, artifactKey: "artifact-1", source: SOURCE, catalog,
    provenance: { producer_id: "test-author" }, draft: usesDraft(catalog, ASSERTION),
    producer_version: "p1", contract_version: "source-interpretation-v4"
  });
  const allIds = [published.bound.interpretation_id];
  for (let index = 1; index < (options.count ?? 1); index += 1) {
    const draft = usesDraft(catalog, ASSERTION);
    const extra = await createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 }).publish({
      workspaceId: WS, runId: RUN, artifactKey: "artifact-1", source: SOURCE, catalog,
      provenance: { producer_id: "test-author" }, draft: { ...draft,
        gaps: options.large && index === (options.count ?? 1) - 1 ? Array.from({ length: 40 }, () => ({
          kind: "unsupported_meaning", affected_ids: [], support: [], description: "字".repeat(800)
        })) : [] }, producer_version: `p${index + 1}`, contract_version: "source-interpretation-v4"
    });
    if (options.large && index === (options.count ?? 1) - 1) {
      expect(JSON.stringify(extra.bound).length).toBeLessThan(65536);
      expect(Buffer.byteLength(JSON.stringify(extra.bound))).toBeGreaterThan(65536);
    }
    allIds.push(extra.bound.interpretation_id);
  }
  expect(database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
  expect(database.connection.prepare("SELECT count(*) AS n FROM relation_assertions").get()).toEqual({ n: 0 });
  if (options.state === "superseded") {
    await admission.admit({
      workspace_id: WS, source_id: "artifact-1", source_version: "2", content_bytes: SOURCE,
      evidence_object_id: null, recorded_at: "2026-09-19T00:00:00.000Z", event_time: null,
      valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
      spans: deriveAddressableSpanViews(SOURCE)
    }, { workspaceId: WS });
  }
  if (options.state === "erased") {
    const eraser = new SqliteFieldEraseBarrierRepo(database, fieldContractSha256);
    const barrier = {
      identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", admitted.record.identity, ""], fieldContractSha256),
      barrier_id: "erase-semantic-source", workspace_id: WS, generation_id: null,
      subject_kind: "source_record" as const, subject_id: admitted.record.identity, erased_at: CLOCK
    };
    eraser.apply(barrier); eraser.apply(barrier);
  }
  database.close(); closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    await client.ready();
    await body({
      hId: published.bound.interpretation_id, allIds, execute: (input) => client.sourceSemanticsPort!.execute(input),
      filename, client
    });
  } finally {
    await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  }
}

function call(execute: Execute, request: SourceSemanticWorkerRequest, extra: {
  authorized_scopes?: { mode: "denied" } | { mode: "named"; scopes: readonly string[] } | { mode: "unrestricted" };
  expires_at?: string; principal?: string; as_of?: string;
} = {}) {
  return execute({
    workspace_id: WS, as_of: extra.as_of ?? CLOCK,
    authorized_scopes: extra.authorized_scopes ?? { mode: "named", scopes: ["project"] },
    ...(extra.expires_at === undefined ? {} : { expires_at: extra.expires_at }),
    ...(extra.principal === undefined ? {} : { principal: extra.principal }),
    request
  });
}

it("keeps durable legacy interpretation bytes and identity while failing closed through the worker", async () => {
  await withPublished(async ({ hId, execute, filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const repo = new SqliteEvidenceCapsuleRepo(database);
    const capsule = await repo.findById(semanticInterpretationEvidenceId(hId, fieldContractSha256));
    if (capsule === null) throw new Error("published capsule missing");
    const current = JSON.parse(capsule.gist), h = { ...current.interpretation,
      contract: "source-interpretation-v3", contract_version: "source-interpretation-v3",
      k_version: "source-semantic-k-v2", normalizer_version: "source-semantic-normalizer-v2" };
    const legacyId = `sha256:${fieldContractSha256(canonicalJson({ contract: "published-source-interpretation-v3",
      k_version: h.k_version, normalizer_version: h.normalizer_version, source: h.source,
      producer_id: h.producer_id, producer_version: h.producer_version, contract_version: h.contract_version,
      body: { contract: h.contract, mentions: h.mentions.map(({ utf8_span: _span, span_space: _space, ...row }: Record<string, unknown>) => row),
        referents: h.referents, frames: h.frames, operators: h.operators, gaps: h.gaps,
        entry_roots: h.entry_roots, asserted_at_scope: h.asserted_at_scope } }))}`;
    const oldBytes = JSON.stringify({ ...current, contract: "published-source-interpretation-v3", interpretation_id: legacyId, interpretation: h });
    const evidenceId = semanticInterpretationEvidenceId(legacyId, fieldContractSha256);
    await repo.create({ ...capsule, object_id: evidenceId, gist: oldBytes });
    database.close(); closeCachedDatabase(filename);
    expect((await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET })).kind).toBe("prepare_source");
    const discovered = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    expect(discovered.kind).toBe("prepare_query");
    if (discovered.kind !== "prepare_query") throw new Error("query preparation expected");
    expect(discovered.candidates.some((row) => row.interpretation_id === legacyId)).toBe(false);
    expect(discovered.coverage.discovery).toBe("complete");
    await expect(call(execute, { kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: legacyId, query_semantics: queryOf(), semantic_correspondence: alignmentOf(legacyId, queryOf()), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000 })).rejects.toMatchObject({ code: "VALIDATION",
      details: expect.objectContaining({ reason: "malformed_interpretation" }) });
    const reopened = await createRecallRealStorage(() => undefined, filename);
    expect((await new SqliteEvidenceCapsuleRepo(reopened.database).findById(evidenceId))?.gist).toBe(oldBytes);
    reopened.database.close(); closeCachedDatabase(filename);
  });
});

it("keeps discovery open and returns typed validation for persisted interpretations missing accounting gaps", async () => {
  await withPublished(async ({ hId, execute, filename }) => {
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const repo = new SqliteEvidenceCapsuleRepo(database);
    const capsule = await repo.findById(semanticInterpretationEvidenceId(hId, fieldContractSha256));
    if (capsule === null) throw new Error("published capsule missing");
    const published = SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(capsule.gist));
    const interpretation = { ...published.interpretation, frames: published.interpretation.frames.map((frame) => ({
      ...frame, bindings: frame.bindings.filter((binding) => binding.slot_id !== "theme")
    })), gaps: [] };
    const corruptedId = sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256);
    // Preserve schema/source/identity validity so the reader must reach accounting validation.
    const corrupted = SourceSemanticPublishedInterpretationSchema.parse({ ...published,
      interpretation_id: corruptedId, interpretation });
    const evidenceId = semanticInterpretationEvidenceId(corruptedId, fieldContractSha256);
    const retainedBytes = JSON.stringify(corrupted);
    await repo.create({ ...capsule, object_id: evidenceId, gist: retainedBytes });
    database.close(); closeCachedDatabase(filename);

    const prepared = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    if (prepared.kind !== "prepare_query") throw new Error("query preparation expected");
    expect(prepared.candidates.map((row) => row.interpretation_id)).toContain(hId);
    expect(prepared.candidates.map((row) => row.interpretation_id)).not.toContain(corruptedId);
    expect(prepared.coverage.discovery).toBe("truncated");
    expect(prepared.coverage.source_interpretation).toBe("open");

    const reason = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
      source_interpretation_id: corruptedId, query_semantics: queryOf(), semantic_correspondence: alignmentOf(corruptedId, queryOf()), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000 };
    await expect(call(execute, reason)).rejects.toMatchObject({ name: "CoreError", code: "VALIDATION",
      message: expect.stringContaining("accounting gaps"), details: {
        work: { native_work: expect.any(Number), logical_work: expect.any(Number) }
      } });
    await expect(call(execute, { ...reason, budget: { ...BUDGET, work_units: 1 } })).rejects.toMatchObject({
      name: "CoreError", code: "CONFLICT", subCode: "RETRYABLE_BACKPRESSURE"
    });
    const reopened = await createRecallRealStorage(() => undefined, filename);
    expect((await new SqliteEvidenceCapsuleRepo(reopened.database).findById(evidenceId))?.gist).toBe(retainedBytes);
    reopened.database.close(); closeCachedDatabase(filename);
  });
});

it("prepares, reasons, and reopens a durable source interpretation through a real worker fork", async () => {
  await withPublished(async ({ hId, execute }) => {
    const q = queryOf();
    const preparedSource = await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET });
    if (preparedSource.kind !== "prepare_source") throw new Error("expected source handle");
    const preparedQuery = await call(execute, {
      kind: "prepare_query", original_query: ORIGINAL, query_semantics: q, budget: BUDGET,
      source_handle: preparedSource.source_handle
    });
    if (preparedQuery.kind !== "prepare_query") throw new Error("expected query handle");
    expect(preparedQuery.candidates.some((row) => row.interpretation_id === hId)).toBe(true);
    const reasoned = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: preparedQuery.query_handle, semantic_correspondence: alignmentOf(hId, q),
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (reasoned.kind !== "reason") throw new Error("expected reason");
    expect(reasoned.result.outcome.status).toBe("interpreted");
    expect(reasoned.result.semantic_status).toBe("unreviewed");
    expect(reasoned.result.world_claim).toBe("unknown");
    expect(reasoned.result.conditional_computation_id).toBeTruthy();
    expect(reasoned.result.consumed_leaves.length).toBeGreaterThan(0);
    expect(reasoned.interpretation).toBeDefined();
    expect(reasoned.semantic_correspondence).toBeDefined();
    expect(reasoned.work.native_work).toBeGreaterThan(0);
    expect(reasoned.work.rss_bytes).toBeGreaterThan(0);
    expect("continuation" in reasoned).toBe(false);
    const retry = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: preparedQuery.query_handle, semantic_correspondence: alignmentOf(hId, q),
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (retry.kind !== "reason") throw new Error("expected retry");
    expect(retry.work.native_work).toBeGreaterThan(0);
    expect("continuation" in retry).toBe(false);
    const clipped = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1024
    });
    if (clipped.kind !== "reason") throw new Error("expected clipped");
    expect(clipped.result.outcome.status).toBe("truncated");
    expect(clipped.result.consumed_leaves).toEqual([]);
    expect(clipped.interpretation).toBeUndefined();
    expect(clipped.semantic_correspondence).toBeUndefined();
    expect(clipped.result.semantic_status).toBe("unreviewed");
    expect(clipped.result.world_claim).toBe("unknown");
    expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(1024);
  });
}, 30000);

it("rejects missing, empty, and null permission admissions", async () => {
  expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", JSON.parse(JSON.stringify({
    workspace_id: WS, as_of: CLOCK, authorized_scopes: null,
    request: { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET }
  })))).toThrow();
  expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", {
    workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: [] },
    request: { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET }
  })).toThrow();
  await withPublished(async ({ execute }) => {
    await expect(call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET },
      { authorized_scopes: { mode: "denied" } })).rejects.toThrow(/scope|admission/u);
  });
  await withPublished(async ({ execute }) => {
    await expect(call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET }))
      .rejects.toThrow(/scope/u);
  }, { scope: "global_core" });
});

it("invalidates expired handles and does not recover them after worker loss", async () => {
  await withPublished(async ({ hId, execute, filename, client }) => {
    const prepared = await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET },
      { expires_at: CLOCK });
    if (prepared.kind !== "prepare_source") throw new Error("expected source handle");
    await expect(call(execute, {
      kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET,
      source_handle: prepared.source_handle
    })).rejects.toThrow(/expired/u);
    const q = queryOf();
    const oneshot = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (oneshot.kind !== "reason") throw new Error("expected oneshot");
    expect(oneshot.result.outcome.status).toBe("interpreted");
    const live = await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET });
    if (live.kind !== "prepare_source") throw new Error("expected live handle");
    await client.close();
    const reopened = createRecallReadWorkerClient({
      databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
    })!;
    try {
      await reopened.ready();
      const next = (input: Parameters<Execute>[0]) => reopened.sourceSemanticsPort!.execute(input);
      await expect(call(next, {
        kind: "prepare_query", original_query: ORIGINAL, query_semantics: q, budget: BUDGET,
        source_handle: live.source_handle
      })).rejects.toThrow();
      const durable = await call(next, {
        kind: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: hId, query_semantics: q, semantic_correspondence: alignmentOf(hId, q), original_query: ORIGINAL,
        budget: BUDGET, output_byte_limit: 1000000
      });
      if (durable.kind !== "reason") throw new Error("expected a durable source interpretation");
      expect(durable.result.outcome.status).toBe("interpreted");
      expect(durable.result.source_interpretation_id).toBe(hId);
    } finally { await reopened.close(); }
  });
}, 30000);

it.each(["erased", "superseded"] as const)("refuses %s source state after reopening", async (state) => {
  await withPublished(async ({ hId, execute }) => {
    const q = queryOf();
    await expect(call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    })).rejects.toThrow();
  }, { state });
});

it("does not let a cache hit bypass erasure in the worker snapshot", async () => {
  await withPublished(async ({ hId, execute, filename }) => {
    const q = queryOf();
    const first = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (first.kind !== "reason") throw new Error("expected first reason");
    expect(first.result.outcome.status).toBe("interpreted");
    const { database } = await createRecallRealStorage(() => undefined, filename);
    const source = database.connection.prepare(
      "SELECT record_id FROM source_records WHERE workspace_id=? LIMIT 1"
    ).get(WS) as { record_id: string };
    const eraser = new SqliteFieldEraseBarrierRepo(database, fieldContractSha256);
    const barrier = {
      identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", source.record_id, ""], fieldContractSha256),
      barrier_id: "erase-cached-semantic", workspace_id: WS, generation_id: null,
      subject_kind: "source_record" as const, subject_id: source.record_id, erased_at: CLOCK
    };
    eraser.apply(barrier); eraser.apply(barrier);
    database.close();
    await expect(call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    })).rejects.toThrow();
  });
}, 30000);

it("paginates current interpretations including a large source interpretation and exposes the semantic body needed by semantic correspondence", async () => {
  await withPublished(async ({ allIds, execute }) => {
    const q = queryOf(), seen = new Set<string>();
    let continuation: string | undefined;
    let count = 0;
    do {
      const page = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: q, budget: BUDGET,
        ...(continuation === undefined ? {} : { continuation_handle: continuation }) });
      expect(page.kind).toBe("prepare_query");
      if (page.kind !== "prepare_query") throw new Error("expected query page");
      for (const descriptor of page.candidates) {
        expect(seen.has(descriptor.interpretation_id)).toBe(false);
        expect(descriptor.interpretation?.frames[0]?.bindings.length).toBe(2);
        expect(descriptor.interpretation?.mentions[0]?.source_ref).toBeDefined();
        seen.add(descriptor.interpretation_id);
      }
      continuation = page.continuation_handle;
      if (continuation === undefined) expect(page.coverage.discovery).toBe("complete");
      expect(++count).toBeLessThan(10);
    } while (continuation !== undefined);
    expect([...seen].sort()).toEqual([...allIds].sort());
    expect(count).toBeGreaterThan(1);
  }, { count: 20, large: true });
}, 30000);

it("does not disclose unauthorized or obsolete descriptors", async () => {
  await withPublished(async ({ execute }) => {
    const page = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    if (page.kind !== "prepare_query") throw new Error("expected query page");
    expect(page.candidates).toEqual([]);
  }, { scope: "global_core" });
  await withPublished(async ({ execute }) => {
    const page = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    if (page.kind !== "prepare_query") throw new Error("expected query page");
    expect(page.candidates).toEqual([]);
  }, { state: "superseded" });
});

it("binds query handles to query semantics, candidates and permissions and keeps one-shot discovery unexercised", async () => {
  await withPublished(async ({ hId, execute }) => {
    const q = queryOf(), a = alignmentOf(hId, q);
    const prepared = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: q, budget: BUDGET }, { principal: "owner" });
    if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("expected query lease");
    const request = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
      query_handle: prepared.query_handle, semantic_correspondence: a, budget: BUDGET, output_byte_limit: 1000000 };
    await expect(call(execute, { ...request, query_semantics: { ...q, gaps: [{ kind: "comparison", affected_ids: [],
      support: [{ kind: "query_text", excerpt: "tools" }] }] } }, { principal: "owner" })).rejects.toThrow(/retargeted/);
    await expect(call(execute, { ...request, source_interpretation_id: `sha256:${"f".repeat(64)}` }, { principal: "owner" })).rejects.toThrow(/candidates/);
    await expect(call(execute, request, { principal: "owner", authorized_scopes: { mode: "unrestricted" } })).rejects.toThrow(/scope admission/);
    await expect(call(execute, request, { principal: "other" })).rejects.toThrow(/principal/);
    const leased = await call(execute, request, { principal: "owner" });
    const direct = await call(execute, { kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: a, original_query: ORIGINAL, budget: BUDGET, output_byte_limit: 1000000 }, { principal: "owner" });
    if (leased.kind !== "reason" || direct.kind !== "reason") throw new Error("expected reason");
    expect(leased.result.conditional_computation_id).toBe(direct.result.conditional_computation_id);
    expect(leased.coverage.discovery).toBe("complete");
    expect(direct.coverage.discovery).toBe("unexercised");
    expect(leased.coverage.source_interpretation).toBe("open"); expect(leased.coverage.semantic_correspondence).toBe("open");
    expect(leased.result.answers).toEqual(direct.result.answers);
    expect(direct.work.logical_work).toBeGreaterThan(direct.work.native_work);
  });
});

it("retains typed domain errors and measured work across the real worker boundary", async () => {
  await withPublished(async ({ execute }) => {
    await expect(call(execute, { kind: "prepare_source", source_id: "absent-source", budget: BUDGET }))
      .rejects.toMatchObject({ name: "CoreError", code: "NOT_FOUND", details: { work: { native_work: expect.any(Number), logical_work: expect.any(Number) } } });
  });
});

it("reports a failed semantic_correspondence as invalid instead of charging a default Core budget", async () => {
  await withPublished(async ({ hId, execute }) => {
    const q = queryOf();
    const a = alignmentOf(hId, q);
    const forged = { ...a, correspondences: a.correspondences.map((row) => ({
      ...row, query_support: { kind: "query_text" as const, excerpt: "invented support" }
    })) };
    const result = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: forged, original_query: ORIGINAL,
      budget: { ...BUDGET, work_units: 4000, memory_bytes: 200000 }, output_byte_limit: 1000000
    });
    if (result.kind !== "reason") throw new Error("expected reason");
    expect(result.result.outcome).toEqual({ status: "invalid", reason: "malformed_correspondence" });
    expect(result.coverage.conditional_computation).toBe("unexercised");
  });
});

it("reasons through the worker on receiver-produced query and semantic_correspondence bodies", async () => {
  await withPublished(async ({ hId, execute }) => {
    const qCanonical = queryOf();
    const receivedQ = authoredQuerySemantics({ original_query: ORIGINAL, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
          variables: qCanonical.variables,
          alternatives: qCanonical.alternatives,
          return_variables: qCanonical.return_variables,
          gaps: qCanonical.gaps
        });
    expect(receivedQ.outcome.status).toBe("interpreted");
    expect(receivedQ.query).toEqual(qCanonical);
    const prepared = await call(execute, {
      kind: "prepare_query", original_query: ORIGINAL, query_semantics: receivedQ.query, budget: BUDGET
    });
    if (prepared.kind !== "prepare_query") throw new Error("expected query page");
    const candidate = prepared.candidates.find((row) => row.interpretation_id === hId);
    if (candidate?.interpretation === undefined) throw new Error("published interpretation missing from descriptors");
    const receivedA = receiveAuthoredCorrespondence({ original_query: ORIGINAL, admitted_query_semantics: receivedQ.query!, source_interpretation_descriptors: [{ source_interpretation_id: candidate.interpretation_id, interpretation: candidate.interpretation }], producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences: alignmentOf(hId, receivedQ.query!).correspondences }, { status: "interpreted", gaps: [] });
    expect(receivedA.semantic_correspondence?.source_interpretation_id).toBe(hId);
    const result = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle, semantic_correspondence: receivedA.semantic_correspondence,
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (result.kind !== "reason") throw new Error("expected reason");
    expect(result.result.outcome.status).toBe("interpreted");
    expect(result.result.answers?.[0]?.returned.tools?.node_id).toBe("rTools");
    expect(result.result.world_claim).toBe("unknown");
  });
});

it("delivers qualified answers through the actual CLI executable with no provider credentials", async () => {
  await withPublished(async ({ hId, filename, client }) => {
    await client.close();
    const q = queryOf(), args = { operation: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: hId, query_semantics: q, semantic_correspondence: alignmentOf(hId, q), original_query: ORIGINAL, budget: BUDGET, output_byte_limit: 1000000 };
    const root = dirname(filename), binary = fileURLToPath(new URL("../../../../../../bin/alaya.mjs", import.meta.url));
    const output = await promisify(execFile)(process.execPath, [binary, "tools", "call", "soul.interpretation", JSON.stringify(args),
      "--workspace", WS, "--run", RUN, "--agent", "codex", "--json"], {
      cwd: root, timeout: 30000, maxBuffer: 2_000_000,
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, DATA_DIR: root }
    });
    const parsed = JSON.parse(output.stdout);
    expect(parsed).toMatchObject({ result: { outcome: { status: "interpreted" }, world_claim: "unknown", semantic_status: "unreviewed" }, provider_attempts: 0 });
    expect(parsed.result.answers[0].returned.tools.node_id).toBe("rTools");
    expect(parsed.interpretation).toBeDefined(); expect(parsed.semantic_correspondence).toBeDefined();
  });
}, 45000);
