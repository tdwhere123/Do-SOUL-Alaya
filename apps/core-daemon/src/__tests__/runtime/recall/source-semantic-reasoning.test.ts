import { PassThrough } from "node:stream";
import { withCliInterpretationSession } from "../../support/cli-interpretation-session.test-support.js";
import { createToolsCommand } from "../../../cli/tools.js";
import { createAlayaCliBridge } from "../../../cli/bridge.js";
import { runAlayaCli } from "../../../cli/support/module-loader.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { authoredQuerySemantics, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBenchDaemonConfigDirectoryLease, planBenchDaemonConfigDirectory
} from "../../../../../bench-runner/src/harness/daemon/daemon-config-directory.js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import {
  SoulInterpretationResponseSchema,
  buildSourceReferenceCatalog, hashLabeledIdentity, sourceReferenceResolver, canonicalJson,
  SourceSemanticPublishedInterpretationSchema, sourceSemanticInterpretationIdentity,
  type SourceReferenceCatalog, type SourceSemanticCorrespondence, type SourceSemanticQuery,
  type SourceSemanticWorkerRequest,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
  UNKNOWN_UTTERANCE_ATTRIBUTION, unavailableSourceQueryPreparation,
  sourceSemanticExecutionPhases, SourceSemanticExecutionSchema, sourceSemanticReasonControl, sourceDisclosure
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
import { createRecallReadWorkerClient, type RecallReadWorkerClient, type PrepareSourceQuery }
  from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import {
  createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { openRecallStorage } from "./recall-storage.test-support.js";

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
    contract: "source-semantic-query-v4",
    original_query_digest: digestOriginalQuery(ORIGINAL),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v4",
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

function correspondenceOf(sourceInterpretationId: string, querySemantics: SourceSemanticQuery): SourceSemanticCorrespondence {
  const admitted = admitSourceSemanticQuery(querySemantics, ORIGINAL);
  if (admitted.kind !== "admitted") throw new Error("query must admit");
  return {
    contract: "source-semantic-correspondence-v3",
    source_interpretation_id: sourceInterpretationId, query_semantics_id: admitted.query_id,
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
  sourceInterpretationId: string; sourceRecordId: string; allIds: readonly string[]; execute: Execute; filename: string; client: RecallReadWorkerClient;
}) => Promise<void>, options: Readonly<{
  valid_from?: string; valid_to?: string; state?: "erased" | "superseded";
  scope?: "project" | "global_core"; count?: number; large?: boolean; workerCount?: number; legacyKeys?: boolean;
  prepareSourceQuery?: PrepareSourceQuery;
}> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-reasoning-"));
  const filename = join(directory, "alaya.db");
  const { database } = await openRecallStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const evidenceService = new EvidenceService({
    eventLogRepo, runtimeNotifier, evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK
  });
  const publicationEvidenceService = options.legacyKeys !== true ? evidenceService : {
    findByIdScoped: (id: string, workspace: string) => evidenceService.findByIdScoped(id, workspace),
    create: (value: Parameters<EvidenceService["create"]>[0], ...rest: Parameters<EvidenceService["create"]> extends [unknown, ...infer Rest] ? Rest : never) =>
      evidenceService.create({ ...value, object_id: semanticInterpretationEvidenceId(JSON.parse(value.gist).interpretation_id, fieldContractSha256) }, ...rest)
  };
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  const admitted = await admission.admit({
    workspace_id: WS, source_id: "artifact-1", source_version: "1", content_bytes: SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null,
    valid_from: options.valid_from ?? null, valid_to: options.valid_to ?? null,
    speaker: "user", scope_class: options.scope ?? "project", spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  const catalog = catalogFor(ASSERTION);
  const published = await createSourceSemanticInterpretationPublication({
    stores, evidenceService: publicationEvidenceService, sha256: fieldContractSha256
  }).publish({
    workspaceId: WS, runId: RUN, artifactKey: "artifact-1", source: SOURCE, catalog,
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, Buffer.byteLength(SOURCE)] }],
    provenance: { producer_id: "test-author" }, draft: usesDraft(catalog, ASSERTION),
    producer_version: "p1", contract_version: "source-interpretation-v4"
  });
  const allIds = [published.bound.interpretation_id];
  for (let index = 1; index < (options.count ?? 1); index += 1) {
    const draft = usesDraft(catalog, ASSERTION);
    const extra = await createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 }).publish({
      workspaceId: WS, runId: RUN, artifactKey: "artifact-1", source: SOURCE, catalog,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, Buffer.byteLength(SOURCE)] }],
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
  const guard = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
  process.execArgv.push(guard);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: options.workerCount ?? 1,
    prepareSourceQuery: options.prepareSourceQuery })!;
  try {
    await client.ready();
    await body({
      sourceInterpretationId: published.bound.interpretation_id, sourceRecordId: admitted.record.identity, allIds, execute: (input) => client.sourceSemanticsPort!.execute(input),
      filename, client
    });
  } finally {
    await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
    const index = process.execArgv.lastIndexOf(guard);
    if (index !== -1) process.execArgv.splice(index, 1);
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

it("fits preparation-required reasons at native and public UTF-8 boundaries without inventing conclusions", async () => {
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const publicReason = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
    for (const extra of [{}, { query_semantics: queryOf() }, { semantic_correspondence: correspondenceOf(sourceInterpretationId, queryOf()) }]) {
      const request = { accepts_unreviewed_conditional_results: true as const,
        source_interpretation_id: sourceInterpretationId, original_query: ORIGINAL, budget: BUDGET,
        output_byte_limit: 1024, ...extra };
      const native = await call(execute, { kind: "reason", ...request });
      const response = await publicReason({ operation: "reason", ...request }, { workspaceId: WS, runId: RUN, agentTarget: "test", sessionId: "test" });
      expect(Buffer.byteLength(JSON.stringify(native), "utf8")).toBeLessThanOrEqual(1024);
      expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(1024);
      if (native.kind !== "reason" || response.operation !== "reason") throw new Error("expected reasons");
      const missing = "query_semantics" in extra ? "semantic_correspondence"
        : "semantic_correspondence" in extra ? "query_semantics" : "query_semantics_and_correspondence";
      expect(sourceSemanticReasonControl(native).outcome).toEqual({ status: "preparation_required", missing });
      expect(sourceSemanticReasonControl(response).outcome).toEqual(sourceSemanticReasonControl(native).outcome);
      expect(native.execution).toBe("native_reasoning_only");
      expect(response.execution).toBe("native_reasoning_only");
      expect(response).not.toHaveProperty("provider_attempts");
      expect(response).not.toHaveProperty("result");
      expect(response).not.toHaveProperty("interpretation");
      expect(response.work.native_work).toBeGreaterThan(0);
      console.info("preparation receipt bytes", { native: Buffer.byteLength(JSON.stringify(native), "utf8"),
        public: Buffer.byteLength(JSON.stringify(response), "utf8") });
      expect(response.coverage.payload).toBe("truncated");
    }
  });
});

it.each(["absent", "complete", "open"] as const)("preserves %s query coverage when correspondence is missing", async status => {
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const query: SourceSemanticQuery | undefined = status === "absent" ? undefined : {
      ...queryOf(), gaps: status === "open" ? [{ kind: "comparison", affected_ids: [],
        support: [{ kind: "query_text", excerpt: "tools" }] }] : []
    };
    const publicReason = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
    const request = { accepts_unreviewed_conditional_results: true as const,
      source_interpretation_id: sourceInterpretationId, original_query: ORIGINAL, budget: BUDGET,
      output_byte_limit: 1_000_000, ...(query === undefined ? {} : { query_semantics: query }) };
    const prepared = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, budget: BUDGET,
      ...(query === undefined ? {} : { query_semantics: query }) });
    const response = await publicReason({ operation: "reason", ...request },
      { workspaceId: WS, runId: RUN, agentTarget: "test", sessionId: "test" });
    if (response.operation !== "reason") throw new Error("expected public reason");
    const expected = status === "absent" ? "unexercised" : status;
    expect(prepared.coverage.query_semantics).toBe(expected);
    expect(response.coverage.query_semantics).toBe(expected);
    expect(response.result?.outcome).toEqual({ status: "preparation_required",
      missing: query === undefined ? "query_semantics_and_correspondence" : "semantic_correspondence" });
    expect(response.result?.world_claim).toBe("unknown");
    expect(response.coverage.conditional_computation).toBe("unexercised");
    if (query !== undefined) expect(response.query?.gaps).toEqual(query.gaps);
  });
});

it("fits multibyte preparation output and measures the public envelope rather than the native envelope", async () => {
  await withPublished(async ({ allIds, execute }) => {
    const request = { accepts_unreviewed_conditional_results: true as const, source_interpretation_id: allIds[1]!,
      original_query: ORIGINAL, budget: { ...BUDGET, work_units: 1_000_000 }, output_byte_limit: 1_000_000 };
    const full = await call(execute, { kind: "reason", ...request });
    if (full.kind !== "reason") throw new Error("expected reason");
    const nativeBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
    expect(nativeBytes).toBeGreaterThan(JSON.stringify(full).length);
    const publicReason = createSourceSemanticInterpretationHandler({ now: () => CLOCK,
      sourceSemanticsPort: { execute: async () => full } });
    const response = await publicReason({ operation: "reason", ...request, output_byte_limit: nativeBytes },
      { workspaceId: WS, runId: RUN, agentTarget: "test", sessionId: "test" });
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(nativeBytes);
    expect(response.coverage.payload).toBe("truncated");
    if (response.operation !== "reason") throw new Error("expected reason");
    expect(sourceSemanticReasonControl(response).outcome.status).toBe("preparation_required");
    expect(full.result).toBeDefined();
    expect(full.interpretation).toBeDefined();
    expect(full.result?.world_claim).toBe("unknown");
    expect(response).not.toHaveProperty("result");
    console.info("multibyte receipt bytes", { nativeFull: nativeBytes,
      public: Buffer.byteLength(JSON.stringify(response), "utf8") });
  }, { count: 2, large: true });
});

it("waits for an independent semantic request instead of inheriting an ordinary worker snapshot", async () => {
  await withPublished(async ({ execute, client, filename, sourceRecordId }) => {
    let ready!: () => void, release!: () => void;
    const opened = new Promise<void>(resolve => { ready = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const snapshot = client.readSnapshot.isolate!(async () => {
      await client.readSnapshot.beginDeferred();
      try {
        await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET });
        ready(); await hold;
      } finally { await client.readSnapshot.rollback(); }
    });
    await opened;
    let settled = false;
    const writer = await openRecallStorage(() => undefined, filename);
    try {
      new SqliteFieldEraseBarrierRepo(writer.database, fieldContractSha256).apply({
        identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", sourceRecordId, ""], fieldContractSha256),
        barrier_id: "erase-during-independent-read", workspace_id: WS, generation_id: null,
        subject_kind: "source_record", subject_id: sourceRecordId, erased_at: CLOCK
      });
    } finally { writer.database.close(); closeCachedDatabase(filename); }
    const independent = call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET }).finally(() => { settled = true; });
    const rejected = expect(independent).rejects.toThrow();
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(settled).toBe(false);
    } finally { release(); await snapshot; }
    await rejected;
  });
});

it("redeems query preparation on its owning nondefault worker after another snapshot releases", async () => {
  await withPublished(async ({ execute, client, sourceInterpretationId }) => {
    let ready!: () => void, release!: () => void;
    const opened = new Promise<void>(resolve => { ready = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const snapshot = client.readSnapshot.isolate!(async () => {
      await client.readSnapshot.beginDeferred(); ready();
      try { await hold; } finally { await client.readSnapshot.rollback(); }
    });
    await opened;
    let prepared: Awaited<ReturnType<Execute>>;
    try {
      prepared = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    } finally { release(); await snapshot; }
    if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("expected query handle");
    const reason = await call(execute, { kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle, source_interpretation_id: sourceInterpretationId, budget: BUDGET, output_byte_limit: 1000000 });
    expect(reason.kind).toBe("reason");
    const recall = await call(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle, budget: BUDGET, output_byte_limit: 1000000 });
    expect(recall.kind).toBe("recall");
    if (recall.kind !== "recall") throw new Error("expected library recall");
    expect(recall.index.entries).toHaveLength(1);
  }, { workerCount: 2 });
});

it("reads current legacy-key H through the worker without mutation and rejects ambiguous or foreign lookups", async () => {
  await withPublished(async ({ execute, sourceInterpretationId, filename }) => {
    const reason = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
      source_interpretation_id: sourceInterpretationId, original_query: ORIGINAL, query_semantics: queryOf(),
      semantic_correspondence: correspondenceOf(sourceInterpretationId, queryOf()), budget: BUDGET, output_byte_limit: 1_000_000 };
    const result = await call(execute, reason);
    if (result.kind !== "reason" || result.result === undefined) throw new Error("full reason expected");
    expect(result.result.outcome.status).toBe("interpreted");
    const discovery = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    if (discovery.kind !== "prepare_query") throw new Error("query expected");
    expect(discovery.candidates.map(row => row.interpretation_id)).toContain(sourceInterpretationId);
    await expect(execute({ workspace_id: "foreign", as_of: CLOCK, authorized_scopes: { mode: "unrestricted" }, request: reason }))
      .rejects.toThrow(/absent/u);
    const { database } = await openRecallStorage(() => undefined, filename);
    const repo = new SqliteEvidenceCapsuleRepo(database);
    const legacy = semanticInterpretationEvidenceId(sourceInterpretationId, fieldContractSha256);
    const original = await repo.findById(legacy);
    if (original === null) throw new Error("legacy row missing");
    await repo.create({ ...original, object_id: semanticInterpretationEvidenceId(sourceInterpretationId, fieldContractSha256, WS) });
    expect((await repo.findById(legacy))?.gist).toBe(original.gist);
    database.close(); closeCachedDatabase(filename);
    await expect(call(execute, reason)).rejects.toThrow(/ambiguous/u);
    const ambiguous = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
    if (ambiguous.kind !== "prepare_query") throw new Error("query expected");
    expect(ambiguous.candidates).toEqual([]);
    expect(ambiguous.coverage.discovery).toBe("truncated");
  }, { legacyKeys: true });
});

it("keeps durable legacy interpretation bytes and identity while failing closed through the worker", async () => {
  await withPublished(async ({ sourceInterpretationId, execute, filename }) => {
    const { database } = await openRecallStorage(() => undefined, filename);
    const repo = new SqliteEvidenceCapsuleRepo(database);
    const capsule = await repo.findById(semanticInterpretationEvidenceId(sourceInterpretationId, fieldContractSha256, WS));
    if (capsule === null) throw new Error("published capsule missing");
    const current = JSON.parse(capsule.gist), sourceInterpretation = { ...current.interpretation,
      contract: "source-interpretation-v3", contract_version: "source-interpretation-v3",
      k_version: "source-semantic-k-v2", normalizer_version: "source-semantic-normalizer-v2" };
    const legacyId = `sha256:${fieldContractSha256(canonicalJson({ contract: "published-source-interpretation-v3",
      k_version: sourceInterpretation.k_version, normalizer_version: sourceInterpretation.normalizer_version, source: sourceInterpretation.source,
      producer_id: sourceInterpretation.producer_id, producer_version: sourceInterpretation.producer_version, contract_version: sourceInterpretation.contract_version,
      body: { contract: sourceInterpretation.contract, mentions: sourceInterpretation.mentions.map(({ utf8_span: _span, span_space: _space, ...row }: Record<string, unknown>) => row),
        referents: sourceInterpretation.referents, frames: sourceInterpretation.frames, operators: sourceInterpretation.operators, gaps: sourceInterpretation.gaps,
        entry_roots: sourceInterpretation.entry_roots, asserted_at_scope: sourceInterpretation.asserted_at_scope } }))}`;
    const oldBytes = JSON.stringify({ ...current, contract: "published-source-interpretation-v3", interpretation_id: legacyId, interpretation: sourceInterpretation });
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
      source_interpretation_id: legacyId, query_semantics: queryOf(), semantic_correspondence: correspondenceOf(legacyId, queryOf()), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000 })).rejects.toMatchObject({ code: "VALIDATION",
      details: expect.objectContaining({ reason: "malformed_interpretation" }) });
    const reopened = await openRecallStorage(() => undefined, filename);
    expect((await new SqliteEvidenceCapsuleRepo(reopened.database).findById(evidenceId))?.gist).toBe(oldBytes);
    reopened.database.close(); closeCachedDatabase(filename);
  });
});

it("keeps discovery open and returns typed validation for persisted interpretations missing accounting gaps", async () => {
  await withPublished(async ({ sourceInterpretationId, execute, filename }) => {
    const { database } = await openRecallStorage(() => undefined, filename);
    const repo = new SqliteEvidenceCapsuleRepo(database);
    const capsule = await repo.findById(semanticInterpretationEvidenceId(sourceInterpretationId, fieldContractSha256, WS));
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
    expect(prepared.candidates.map((row) => row.interpretation_id)).toContain(sourceInterpretationId);
    expect(prepared.candidates.map((row) => row.interpretation_id)).not.toContain(corruptedId);
    expect(prepared.coverage.discovery).toBe("truncated");
    expect(prepared.coverage.source_interpretation).toBe("open");

    const reason = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
      source_interpretation_id: corruptedId, query_semantics: queryOf(), semantic_correspondence: correspondenceOf(corruptedId, queryOf()), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000 };
    await expect(call(execute, reason)).rejects.toMatchObject({ name: "CoreError", code: "VALIDATION",
      message: expect.stringContaining("accounting gaps"), details: {
        work: { native_work: expect.any(Number), logical_work: expect.any(Number) }
      } });
    await expect(call(execute, { ...reason, budget: { ...BUDGET, work_units: 1 } })).rejects.toMatchObject({
      name: "CoreError", code: "CONFLICT", subCode: "RETRYABLE_BACKPRESSURE"
    });
    const reopened = await openRecallStorage(() => undefined, filename);
    expect((await new SqliteEvidenceCapsuleRepo(reopened.database).findById(evidenceId))?.gist).toBe(retainedBytes);
    reopened.database.close(); closeCachedDatabase(filename);
  });
});

it("prepares, reasons, and reopens a durable source interpretation through a real worker fork", async () => {
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const querySemantics = queryOf();
    const preparedSource = await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET });
    if (preparedSource.kind !== "prepare_source") throw new Error("expected source handle");
    const preparedQuery = await call(execute, {
      kind: "prepare_query", original_query: ORIGINAL, query_semantics: querySemantics, budget: BUDGET,
      source_handle: preparedSource.source_handle
    });
    if (preparedQuery.kind !== "prepare_query") throw new Error("expected query handle");
    expect(preparedQuery.candidates.some((row) => row.interpretation_id === sourceInterpretationId)).toBe(true);
    const reasoned = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: preparedQuery.query_handle, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics),
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (reasoned.kind !== "reason" || reasoned.result === undefined) throw new Error("expected full reason");
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
      query_handle: preparedQuery.query_handle, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics),
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (retry.kind !== "reason") throw new Error("expected retry");
    expect(retry.work.native_work).toBeGreaterThan(0);
    expect("continuation" in retry).toBe(false);
    for (const limit of [1600, 1024]) {
      const clipped = await call(execute, {
        kind: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics,
        semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics), original_query: ORIGINAL,
        budget: BUDGET, output_byte_limit: limit
      });
      if (clipped.kind !== "reason") throw new Error("expected clipped");
      const clippedControl = sourceSemanticReasonControl(clipped);
      expect(clippedControl.outcome).toEqual(reasoned.result.outcome);
      expect(clippedControl.conditional_computation_id).toBe(reasoned.result.conditional_computation_id);
      expect(clippedControl.source_interpretation_id).toBe(reasoned.result.source_interpretation_id);
      expect(clippedControl.query_semantics_id).toBe(reasoned.result.query_semantics_id);
      expect(clippedControl.semantic_correspondence_id).toBe(reasoned.result.semantic_correspondence_id);
      expect(clippedControl).not.toHaveProperty("attention");
      expect(clipped.no_conclusion).toBeDefined();
      expect(clipped.source_disclosure).toEqual(reasoned.source_disclosure);
      expect(clipped.coverage).toEqual({ discovery: "unexercised", source_interpretation: "open",
        query_semantics: "complete", semantic_correspondence: "open", conditional_computation: "complete", payload: "truncated" });
      expect(clipped).not.toHaveProperty("result");
      expect(clipped).not.toHaveProperty("interpretation");
      expect(clipped).not.toHaveProperty("semantic_correspondence");
      expect(clipped).not.toHaveProperty("query");
      expect(clipped).not.toHaveProperty("context");
      expect(clipped.work.native_work).toBeGreaterThan(0);
      expect(clipped.work.logical_work).toBeGreaterThan(clipped.work.native_work);
      expect(clipped.work.native_bytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(limit);
    }
  });
}, 30000);

it("rejects a compact control receipt when the cap cannot retain bounded source validity", async () => {
  const validFrom = "2026-09-01T00:00:00.000Z", validTo = "2026-10-01T00:00:00.000Z";
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const request = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
      source_interpretation_id: sourceInterpretationId, query_semantics: queryOf(),
      semantic_correspondence: correspondenceOf(sourceInterpretationId, queryOf()), original_query: ORIGINAL,
      budget: BUDGET };
    const full = await call(execute, { ...request, output_byte_limit: 1000000 });
    if (full.kind !== "reason" || full.result === undefined || full.source_disclosure === undefined) {
      throw new Error("expected full reason with source validity");
    }
    expect(sourceDisclosure(full.source_disclosure)).toMatchObject({ source_binding: "checked_record",
      validity: { kind: "bounded", from: validFrom, to_exclusive: validTo }, temporal_state: "within_interval",
      proof_use: { kind: "conditional_support", qualification: "not_world_claim" } });
    const compact = await call(execute, { ...request, output_byte_limit: 1600 });
    if (compact.kind !== "reason") throw new Error("expected compact reason");
    expect(compact.no_conclusion).toBeDefined();
    expect(compact.source_disclosure).toEqual(full.source_disclosure);
    expect(sourceSemanticReasonControl(compact).outcome).toEqual(full.result.outcome);
    expect(compact).not.toHaveProperty("result");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeGreaterThan(1024);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(1600);
    await expect(call(execute, { ...request, output_byte_limit: 1024 }))
      .rejects.toThrow("output budget cannot retain interpretation qualifiers");
  }, { valid_from: validFrom, valid_to: validTo });
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
  await withPublished(async ({ sourceInterpretationId, execute, filename, client }) => {
    const prepared = await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET },
      { expires_at: CLOCK });
    if (prepared.kind !== "prepare_source") throw new Error("expected source handle");
    await expect(call(execute, {
      kind: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET,
      source_handle: prepared.source_handle
    })).rejects.toThrow(/expired/u);
    const querySemantics = queryOf();
    const oneshot = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (oneshot.kind !== "reason" || oneshot.result === undefined) throw new Error("expected full oneshot");
    expect(oneshot.result.outcome.status).toBe("interpreted");
    const live = await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET });
    if (live.kind !== "prepare_source") throw new Error("expected live handle");
    await client.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET }))
        .rejects.toThrow(/closed/u);
    }
    const reopened = createRecallReadWorkerClient({
      databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
    })!;
    try {
      await reopened.ready();
      const next = (input: Parameters<Execute>[0]) => reopened.sourceSemanticsPort!.execute(input);
      await expect(call(next, {
        kind: "prepare_query", original_query: ORIGINAL, query_semantics: querySemantics, budget: BUDGET,
        source_handle: live.source_handle
      })).rejects.toThrow();
      const durable = await call(next, {
        kind: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics), original_query: ORIGINAL,
        budget: BUDGET, output_byte_limit: 1000000
      });
      if (durable.kind !== "reason" || durable.result === undefined) throw new Error("expected a full durable source interpretation");
      expect(durable.result.outcome.status).toBe("interpreted");
      expect(durable.result.source_interpretation_id).toBe(sourceInterpretationId);
    } finally { await reopened.close(); }
  });
}, 30000);

it.each(["erased", "superseded"] as const)("refuses %s source state after reopening", async (state) => {
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const querySemantics = queryOf();
    await expect(call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    })).rejects.toThrow();
  }, { state });
});

it("does not let a cache hit bypass erasure in the worker snapshot", async () => {
  await withPublished(async ({ sourceInterpretationId, execute, filename }) => {
    const querySemantics = queryOf();
    const first = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (first.kind !== "reason" || first.result === undefined) throw new Error("expected first full reason");
    expect(first.result.outcome.status).toBe("interpreted");
    const { database } = await openRecallStorage(() => undefined, filename);
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
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    })).rejects.toThrow();
  });
}, 30000);

it("paginates current interpretations including a large source interpretation and exposes the semantic body needed by semantic correspondence", async () => {
  const prepare = vi.fn<PrepareSourceQuery>(async () => ({
    receipt: unavailableSourceQueryPreparation("fixture_no_selected_profile"),
    vector: { status: "unavailable", reason: "fixture_no_selected_profile" }
  }));
  await withPublished(async ({ allIds, execute }) => {
    const querySemantics = queryOf(), seen = new Set<string>();
    const firstPage = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: querySemantics, budget: BUDGET });
    if (firstPage.kind !== "prepare_query") throw new Error("expected query page");
    expect(firstPage.access?.observed_interpretation_count).toBe(allIds.length);
    expect(firstPage.access?.unvisited_interpretations).toBe(false);
    expect(firstPage.access?.stopping_reasons).toEqual([]);
    expect(firstPage.candidates.length).toBeGreaterThan(0);
    expect(firstPage.candidates.length).toBeLessThan(allIds.length);
    expect(firstPage.access?.trace.omitted_interpretation_count).toBe(allIds.length - firstPage.candidates.length);
    expect(firstPage.continuation_handle).toBeDefined();
    expect(firstPage.coverage.discovery).toBe("truncated");
    expect(firstPage.work.logical_work).toBeLessThanOrEqual(BUDGET.work_units);
    const awaitingCorrespondence = await call(execute, { kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: firstPage.query_handle, source_interpretation_id: firstPage.candidates[0]!.interpretation_id,
      budget: BUDGET, output_byte_limit: 1_000_000 });
    if (awaitingCorrespondence.kind !== "reason" || awaitingCorrespondence.result === undefined) throw new Error("expected full preparation reason");
    expect(awaitingCorrespondence.result.outcome).toEqual({ status: "preparation_required", missing: "semantic_correspondence" });
    expect(awaitingCorrespondence.coverage.discovery).toBe("truncated");
    expect(prepare).toHaveBeenCalledTimes(1);
    const observationBudget = { ...BUDGET, work_units: 1_000_000 };
    let continuation: string | undefined;
    let poolId: string | undefined;
    let count = 0;
    do {
      const page = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: querySemantics, budget: observationBudget,
        ...(continuation === undefined ? {} : { continuation_handle: continuation }) });
      expect(page.kind).toBe("prepare_query");
      if (page.kind !== "prepare_query") throw new Error("expected query page");
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(page.access).toBeDefined();
      if (poolId !== undefined) {
        expect(page.access?.pool_id).toBe(poolId);
        expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(page.execution)).query_preparation.status).toBe("not_requested");
      }
      poolId = page.access?.pool_id;
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
  }, { count: 20, large: true, prepareSourceQuery: prepare });
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
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const querySemantics = queryOf(), semanticCorrespondence = correspondenceOf(sourceInterpretationId, querySemantics);
    const prepared = await call(execute, { kind: "prepare_query", original_query: ORIGINAL, query_semantics: querySemantics, budget: BUDGET }, { principal: "owner" });
    if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("expected query lease");
    const request = { kind: "reason" as const, accepts_unreviewed_conditional_results: true as const,
      query_handle: prepared.query_handle, semantic_correspondence: semanticCorrespondence, budget: BUDGET, output_byte_limit: 1000000 };
    await expect(call(execute, { ...request, query_semantics: { ...querySemantics, gaps: [{ kind: "comparison", affected_ids: [],
      support: [{ kind: "query_text", excerpt: "tools" }] }] } }, { principal: "owner" })).rejects.toThrow(/retargeted/);
    await expect(call(execute, { ...request, source_interpretation_id: `sha256:${"f".repeat(64)}` }, { principal: "owner" })).rejects.toThrow(/candidates/);
    await expect(call(execute, request, { principal: "owner", authorized_scopes: { mode: "unrestricted" } })).rejects.toThrow(/scope admission/);
    await expect(call(execute, request, { principal: "other" })).rejects.toThrow(/principal/);
    const leased = await call(execute, request, { principal: "owner" });
    const direct = await call(execute, { kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: semanticCorrespondence, original_query: ORIGINAL, budget: BUDGET, output_byte_limit: 1000000 }, { principal: "owner" });
    if (leased.kind !== "reason" || direct.kind !== "reason" || leased.result === undefined || direct.result === undefined) {
      throw new Error("expected full leased and direct reasons");
    }
    expect(leased.result.conditional_computation_id).toBe(direct.result.conditional_computation_id);
    expect(leased.coverage.discovery).toBe("complete");
    expect(direct.coverage.discovery).toBe("unexercised");
    expect(leased.coverage.source_interpretation).toBe("open"); expect(leased.coverage.semantic_correspondence).toBe("open");
    expect(leased.result.binding_results).toEqual(direct.result.binding_results);
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
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const querySemantics = queryOf();
    const semanticCorrespondence = correspondenceOf(sourceInterpretationId, querySemantics);
    const forged = { ...semanticCorrespondence, correspondences: semanticCorrespondence.correspondences.map((row) => ({
      ...row, query_support: { kind: "query_text" as const, excerpt: "invented support" }
    })) };
    const result = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: forged, original_query: ORIGINAL,
      budget: { ...BUDGET, work_units: 4000, memory_bytes: 200000 }, output_byte_limit: 1000000
    });
    if (result.kind !== "reason" || result.result === undefined) throw new Error("expected full reason");
    expect(result.result.outcome).toEqual({ status: "invalid", reason: "malformed_correspondence" });
    expect(result.coverage.conditional_computation).toBe("unexercised");
    const publicReason = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
    const bounded = await publicReason({ operation: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: forged,
      original_query: ORIGINAL, budget: BUDGET, output_byte_limit: 1024 },
      { workspaceId: WS, runId: RUN, agentTarget: "test", sessionId: "test" });
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(1024);
    if (bounded.operation !== "reason") throw new Error("expected reason");
    expect(bounded.result).toMatchObject({ outcome: { status: "invalid", reason: "malformed_correspondence" },
      semantic_status: "unreviewed", world_claim: "unknown", conclusion_scope: "conditional_on_interpretation" });
    expect(bounded).not.toHaveProperty("no_conclusion");
  });
});

it("reasons through the worker on receiver-produced query and semantic_correspondence bodies", async () => {
  await withPublished(async ({ sourceInterpretationId, execute }) => {
    const canonicalQuerySemantics = queryOf();
    const receivedQuerySemantics = authoredQuerySemantics({ original_query: ORIGINAL, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
          variables: canonicalQuerySemantics.variables,
          alternatives: canonicalQuerySemantics.alternatives,
          return_variables: canonicalQuerySemantics.return_variables,
          gaps: canonicalQuerySemantics.gaps
        });
    expect(receivedQuerySemantics.outcome.status).toBe("interpreted");
    expect(receivedQuerySemantics.query).toEqual(canonicalQuerySemantics);
    const prepared = await call(execute, {
      kind: "prepare_query", original_query: ORIGINAL, query_semantics: receivedQuerySemantics.query, budget: BUDGET
    });
    if (prepared.kind !== "prepare_query") throw new Error("expected query page");
    const candidate = prepared.candidates.find((row) => row.interpretation_id === sourceInterpretationId);
    if (candidate?.interpretation === undefined) throw new Error("published interpretation missing from descriptors");
    const receivedCorrespondence = receiveAuthoredCorrespondence({ original_query: ORIGINAL, admitted_query_semantics: receivedQuerySemantics.query!, source_interpretation_descriptors: [{ source_interpretation_id: candidate.interpretation_id, interpretation: candidate.interpretation }], producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences: correspondenceOf(sourceInterpretationId, receivedQuerySemantics.query!).correspondences }, { status: "interpreted", gaps: [] });
    expect(receivedCorrespondence.semantic_correspondence?.source_interpretation_id).toBe(sourceInterpretationId);
    const result = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle, semantic_correspondence: receivedCorrespondence.semantic_correspondence,
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (result.kind !== "reason" || result.result === undefined) throw new Error("expected full reason");
    expect(result.result.outcome.status).toBe("interpreted");
    expect(result.result.binding_results?.[0]?.returned.tools?.node_id).toBe("rTools");
    expect(result.result.world_claim).toBe("unknown");
  });
});

it("uses prepare, propose, query preparation and reasoning within the actual persistent CLI session and rejects restart handles", async () => {
  await withPublished(async ({ filename, client, sourceInterpretationId }) => {
    await client.close();
    let oldSourceHandle = "";
    await withCliInterpretationSession(dirname(filename), WS, RUN, async request => {
      const sourceRow = await request({ operation: "prepare_source", source_id: "artifact-1", budget: BUDGET });
      expect(sourceRow.exitCode).toBe(0);
      const source = SoulInterpretationResponseSchema.parse(sourceRow.output);
      if (source.operation !== "prepare_source" || source.catalog === undefined || source.source_handle === undefined) throw new Error("source preparation expected");
      oldSourceHandle = source.source_handle;
      const assertion = source.catalog.assertions[0]!.segments.map(row => row.text).join("");
      const proposed = await request({ operation: "propose", source_handle: source.source_handle,
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4",
        draft: usesDraft(source.catalog, assertion), budget: BUDGET });
      expect(proposed.exitCode).toBe(0);
      expect(proposed.output).toMatchObject({ operation: "propose", outcome: { status: "interpreted" }, execution: "native_reasoning_only" });
      const queryRow = await request({ operation: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET });
      expect(queryRow.exitCode).toBe(0);
      const query = SoulInterpretationResponseSchema.parse(queryRow.output);
      if (query.operation !== "prepare_query" || query.query_handle === undefined) throw new Error("query handle expected");
      const reason = await request({ operation: "reason", accepts_unreviewed_conditional_results: true,
        query_handle: query.query_handle, semantic_correspondence: correspondenceOf(sourceInterpretationId, queryOf()),
        budget: BUDGET, output_byte_limit: 1_000_000 });
      expect(reason.exitCode).toBe(0);
      expect(reason.output).toMatchObject({ result: { outcome: { status: "interpreted" }, world_claim: "unknown" }, execution: "native_reasoning_only" });
    });
    await withCliInterpretationSession(dirname(filename), WS, RUN, async request => {
      const restarted = await request({ operation: "propose", source_handle: oldSourceHandle,
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4",
        draft: usesDraft(catalogFor(ASSERTION), ASSERTION), budget: BUDGET });
      expect(restarted.exitCode).not.toBe(0);
      expect(restarted.output).toMatchObject({ ok: false });
    });
  });
}, 45000);

it("consumes descriptor continuation in the actual CLI session under its original principal", async () => {
  await withPublished(async ({ filename, client }) => {
    await client.close();
    await withCliInterpretationSession(dirname(filename), WS, RUN, async request => {
      const base = { operation: "prepare_query" as const, original_query: ORIGINAL,
        query_semantics: queryOf(), budget: { ...BUDGET, work_units: 1_000_000 } };
      const first = await request(base);
      expect(first.exitCode).toBe(0);
      const prepared = SoulInterpretationResponseSchema.parse(first.output);
      if (prepared.operation !== "prepare_query" || prepared.continuation_handle === undefined) throw new Error("descriptor continuation expected");
      const second = await request({ ...base, continuation_handle: prepared.continuation_handle });
      expect(second.exitCode).toBe(0);
      const page = SoulInterpretationResponseSchema.parse(second.output);
      if (page.operation !== "prepare_query") throw new Error("descriptor page expected");
      const firstIds = new Set(prepared.candidates.map(row => row.interpretation_id));
      expect(page.candidates.length).toBeGreaterThan(0);
      expect(page.candidates.every(row => !firstIds.has(row.interpretation_id))).toBe(true);
      expect(firstIds.size + page.candidates.length).toBe(20);
    });
  }, { count: 20 });
}, 45000);

it("rejects a prepared CLI query when its real worker is lost and cleans up the launcher runtime", async () => {
  await withPublished(async ({ client }) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
      sourceSemanticsPort: client.sourceSemanticsPort });
    let stopped = false;
    const startup = runAlayaCli(["tools", "session", "--workspace", WS, "--run", RUN], {
      stdin, stdout, stderr, env: {}, loadModules: async () => ({
        softwareExit: 70, createAlayaCliBridge,
        createAlayaDaemonRuntime: async () => ({ startupSteps: [], shutdown: async () => { stopped = true; } }) as never,
        registerAlayaCliCommands: bridge => bridge.registerSubcommand(createToolsCommand({ handler,
          runService: { getById: async () => ({ workspace_id: WS }) } }))
      })
    });
    const next = () => new Promise<string>(resolve => stdout.once("data", bytes => resolve(bytes.toString())));
    const first = next();
    stdin.write(`${JSON.stringify({ tool: "soul.interpretation", arguments: { operation: "prepare_query",
      original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET } })}\n`);
    const row = JSON.parse(await first);
    expect(row.exitCode).toBe(0);
    const query = SoulInterpretationResponseSchema.parse(row.output);
    if (query.operation !== "prepare_query" || query.query_handle === undefined) throw new Error("query handle expected");
    await client.close();
    const second = next();
    stdin.write(`${JSON.stringify({ tool: "soul.interpretation", arguments: { operation: "recall",
      accepts_unreviewed_conditional_results: true, query_handle: query.query_handle, budget: BUDGET, output_byte_limit: 1_000_000 } })}\n`);
    const lost = JSON.parse(await second);
    expect(lost.exitCode).not.toBe(0);
    expect(lost.output).toMatchObject({ ok: false });
    stdin.end();
    expect(await startup).toBe(0);
    expect(stopped).toBe(true);
  });
});

it("delivers qualified answers through the actual CLI executable with no provider credentials", async () => {
  await withPublished(async ({ sourceInterpretationId, filename, client }) => {
    await client.close();
    const querySemantics = queryOf(), args = { operation: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: sourceInterpretationId, query_semantics: querySemantics, semantic_correspondence: correspondenceOf(sourceInterpretationId, querySemantics), original_query: ORIGINAL, budget: BUDGET, output_byte_limit: 1000000 };
    const root = dirname(filename), binary = fileURLToPath(new URL("../../../../../../bin/alaya.mjs", import.meta.url));
    // Node loads --import as an ESM URL; a Windows drive path is parsed as a scheme.
    const guard = new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href;
    const configDir = planBenchDaemonConfigDirectory();
    const lease = createBenchDaemonConfigDirectoryLease(configDir);
    await lease.prepare();
    try {
      expect(lease.path).toBe(configDir);
      expect(await readdir(lease.path)).toEqual([]);
      const output = await promisify(execFile)(process.execPath, ["--import", guard, binary, "tools", "call", "soul.interpretation", JSON.stringify(args),
        "--workspace", WS, "--run", RUN, "--agent", "codex", "--json"], {
        cwd: root, timeout: 30000, maxBuffer: 2_000_000,
        env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, DATA_DIR: root, ALAYA_CONFIG_DIR: lease.path }
      });
      expect(lease.path).toBe(configDir);
      expect((await readdir(lease.path)).filter((name) => name === ".env" || name.startsWith(".env."))).toEqual([]);
      const parsed = JSON.parse(output.stdout);
      expect(parsed).toMatchObject({ result: { outcome: { status: "interpreted" }, world_claim: "unknown", semantic_status: "unreviewed" }, execution: "native_reasoning_only" });
      expect(parsed.result.binding_results[0].returned.tools.node_id).toBe("rTools");
      expect(parsed.interpretation).toBeDefined(); expect(parsed.semantic_correspondence).toBeDefined();
    } finally {
      await lease.cleanup();
    }
  });
}, 45000);
