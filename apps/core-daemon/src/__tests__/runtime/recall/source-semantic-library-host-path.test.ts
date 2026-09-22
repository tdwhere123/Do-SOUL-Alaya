import { authoredQuerySemantics, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, hashLabeledIdentity,
  indexEntryCacheKey, materializeSourceSemanticCompactProposal,
  type SourceSemanticCorrespondence, type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery,
  type SoulInterpretationResponse,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticCorrespondence, admitSourceSemanticQuery, createAuditedSourceAdmission,
  createSourceSemanticInterpretationPublication, EvidenceService, fieldContractSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
  sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import {
  closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteFieldEraseBarrierRepo
} from "@do-soul/alaya-storage";
import { proposeCorrespondenceSemantics, proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import {
  createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { soulSearchFromLibraryRecall } from "../../../../../../apps/bench-runner/src/runs/measurement/source-semantic-library-recall.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const ALICE = "Alice uses tools.";
const SILENT = "Bob stays silent.";
const MULTI = "Alice uses tools. Extra clause remains.";
const ORIGINAL = "which tools does Alice use?";
const BUDGET = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};
const SCOPES = { mode: "named" as const, scopes: ["project"] };
const LONG = `User: ${"x".repeat(1995)}`;

type Handler = ReturnType<typeof createMcpMemoryToolHandler>;
type Context = { workspaceId: string; runId: string; agentTarget: string; sessionId: string };
type RecallOut = Extract<SoulInterpretationResponse, { operation: "recall" }>;

function segment(catalog: SourceReferenceCatalog, text: string, assertionId = 1): string {
  const assertion = catalog.assertions.find((row) => row.assertion_id === assertionId);
  const row = assertion?.segments.find((part) => part.text === text);
  if (row === undefined) {
    throw new Error(`catalog lacks ${text}: ${JSON.stringify(assertion?.segments.map((part) => part.text))}`);
  }
  return row.id;
}

function compactUse(catalog: SourceReferenceCatalog) {
  return {
    contract: "source-semantic-proposal-v5" as const,
    outcome: { status: "interpreted" as const },
    content: {
      roots: [{
        act: "assertion" as const,
        expression: {
          kind: "statement" as const,
          predicate: { kind: "explicit" as const, reading: "use", support: segment(catalog, "uses") },
          arguments: [
            { role: "agent", target: segment(catalog, "Alice") },
            { role: "theme", target: segment(catalog, "tools") }
          ]
        }
      }]
    }
  };
}

function receiveInterpretation(source: string, sourceId: string, raw: object, assertionIds: readonly number[] = [1]) {
  const received = proposeSourceSemantics({
    sourceCorpus: source, assertionIds, source_id: sourceId, source_version: "1",
    producer_id: "test-author", producer_version: "p1"
  }, { rawJson: JSON.stringify(raw) });
  if (received.outcome.status !== "interpreted" || received.draft === undefined || received.interpretation === undefined) {
    throw new Error(`compact receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { ...received, draft: received.draft, interpretation: received.interpretation };
}

function existentialBody() {
  return {
    variables: [
      { id: "actor", sort: "entity" as const, reference: { kind: "query_text" as const, excerpt: "Alice" } },
      { id: "tools", sort: "entity" as const },
      { id: "fUse", sort: "proposition" as const }
    ],
    alternatives: [{
      frames: [{
        id: "qUse", variable: "fUse", predicate_reading: "use",
        role_requirements: [
          { id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text" as const, excerpt: "Alice" } },
          { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text" as const, excerpt: "tools" } }
        ]
      }],
      context_obligations: [{ frame: "qUse", kind: "asserted_at_source" as const }]
    }],
    return_variables: ["tools"],
    gaps: [] as const
  };
}

function receiveQuerySemantics(original: string, body: object) {
  const received = authoredQuerySemantics({ original_query: original, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, body);
  if (received.outcome.status !== "interpreted" || received.query === undefined) {
    throw new Error(`query receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { ...received, query: received.query };
}

function mention(interpretation: SourceSemanticInterpretation, text: string) {
  const row = interpretation.mentions.find((item) => item.text === text);
  if (row === undefined) throw new Error(`source interpretation lacks mention ${text}: ${interpretation.mentions.map((item) => item.text).join(",")}`);
  return row;
}

function frameOf(interpretation: SourceSemanticInterpretation, reading: string) {
  const row = interpretation.frames.find((item) => item.predicate_support.reading === reading);
  if (row === undefined) throw new Error(`source interpretation lacks frame ${reading}`);
  return row;
}

function slotOf(interpretation: SourceSemanticInterpretation, reading: string, role: string) {
  const row = frameOf(interpretation, reading).slots.find((item) => item.role_reading === role);
  if (row === undefined) throw new Error(`source interpretation lacks ${role} on ${reading}`);
  return row;
}

function referentOf(interpretation: SourceSemanticInterpretation, text: string) {
  const id = mention(interpretation, text).id;
  const row = interpretation.referents.find((item) => item.mentions.includes(id));
  if (row === undefined) throw new Error(`source interpretation lacks referent for ${text}`);
  return row;
}

function useCorrespondences(interpretation: SourceSemanticInterpretation) {
  const actor = mention(interpretation, "Alice"), tools = mention(interpretation, "tools"), uses = mention(interpretation, "uses");
  const frame = frameOf(interpretation, "use");
  return [
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "referent" as const, variable: "actor" },
      source_endpoint: { kind: "referent" as const, referent: referentOf(interpretation, "Alice").id },
      query_support: { kind: "query_text" as const, excerpt: "Alice" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [actor.id] }] },
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "slot" as const, alternative: 0, frame: "qUse", slot: "agent" },
      source_endpoint: { kind: "slot" as const, frame: frame.id, slot: slotOf(interpretation, "use", "agent").id },
      query_support: { kind: "query_text" as const, excerpt: "Alice" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [actor.id] }] },
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "predicate" as const, alternative: 0, frame: "qUse" },
      source_endpoint: { kind: "frame" as const, frame: frame.id },
      query_support: { kind: "query_text" as const, excerpt: "use" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [uses.id] }] },
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "slot" as const, alternative: 0, frame: "qUse", slot: "theme" },
      source_endpoint: { kind: "slot" as const, frame: frame.id, slot: slotOf(interpretation, "use", "theme").id },
      query_support: { kind: "query_text" as const, excerpt: "tools" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [tools.id] }] }
  ];
}

function receiveCorrespondence(semantics: SourceSemanticQuery, interpretation: SourceSemanticInterpretation, interpretationId: string, extra: object = {}) {
  const received = receiveAuthoredCorrespondence({ original_query: ORIGINAL, admitted_query_semantics: semantics, source_interpretation_descriptors: [{ source_interpretation_id: interpretationId, interpretation: interpretation }], producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences: useCorrespondences(interpretation), ...extra }, { status: "interpreted", gaps: [] });
  if (received.outcome.status !== "interpreted" || received.semantic_correspondence === undefined) {
    throw new Error(`semantic_correspondence receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { ...received, semantic_correspondence: received.semantic_correspondence };
}

async function admitSources(
  filename: string, sources: readonly { id: string; content: string; version?: string; recordedAt?: string }[]
) {
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({
    stores, eventLogRepo, runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  });
  const identities: Record<string, string> = {};
  for (const source of sources) {
    const admitted = await admission.admit({
      workspace_id: WS, source_id: source.id, source_version: source.version ?? "1", content_bytes: source.content,
      evidence_object_id: null, recorded_at: source.recordedAt ?? CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(source.content)
    }, { workspaceId: WS });
    identities[source.id] = admitted.record.identity;
  }
  database.close(); closeCachedDatabase(filename);
  return identities;
}

async function openSession(filename: string) {
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const evidenceService = new EvidenceService({
    eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK
  });
  const publication = createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 });
  const context: Context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "source-semantic-host-path" };
  const handler = createMcpMemoryToolHandler({
    ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort,
    sourceSemanticPublication: { publish: (input) => publication.publish(input) }
  });
  await client.ready();
  return { client, database, handler, context, publication };
}

async function closeSession(session: Awaited<ReturnType<typeof openSession>>, filename: string) {
  try { session.database.close(); } catch { /* closed */ }
  try { await session.client.close(); } catch { /* closed */ }
  closeCachedDatabase(filename);
}

async function callInterpretation(handler: Handler, args: unknown, context: Context) {
  const parsed = SoulInterpretationRequestSchema.parse(args);
  const result = await handler.call({ toolName: "soul.interpretation", arguments: parsed, context });
  if (!result.ok) throw new Error(`soul.interpretation failed: ${JSON.stringify(result)}`);
  return SoulInterpretationResponseSchema.parse(result.output);
}

async function prepareSource(handler: Handler, context: Context, sourceId: string) {
  const output = await callInterpretation(handler, {
    operation: "prepare_source", source_id: sourceId, budget: BUDGET, authorized_scopes: SCOPES
  }, context);
  if (output.operation !== "prepare_source" || output.source_handle === undefined || output.catalog === undefined) {
    throw new Error("prepare_source must return a handle and catalog");
  }
  return { ...output, source_handle: output.source_handle, catalog: output.catalog };
}

async function proposeDraft(handler: Handler, context: Context, sourceHandle: string, draft: unknown, producerVersion: string) {
  const output = await callInterpretation(handler, {
    operation: "propose", source_handle: sourceHandle, draft, producer_id: "test-author",
    producer_version: producerVersion, contract_version: "source-interpretation-v4",
    budget: BUDGET, authorized_scopes: SCOPES
  }, context);
  if (output.operation !== "propose" || output.published === undefined) {
    throw new Error(`propose failed: ${JSON.stringify(output.outcome)}`);
  }
  return output.published;
}

async function workerRecall(
  session: Awaited<ReturnType<typeof openSession>>, semantics: SourceSemanticQuery, semantic_correspondences: readonly SourceSemanticCorrespondence[],
  original = ORIGINAL
) {
  const recalled = await session.client.sourceSemanticsPort!.execute({
    workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
    request: {
      kind: "recall", accepts_unreviewed_conditional_results: true, original_query: original,
      query_semantics: semantics, semantic_correspondences, budget: BUDGET, output_byte_limit: 1_000_000
    }
  });
  if (recalled.kind !== "recall") throw new Error("library recall expected");
  return recalled;
}

async function withHost(
  sources: Parameters<typeof admitSources>[1],
  body: (session: Awaited<ReturnType<typeof openSession>>, filename: string) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-host-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSources(filename, sources);
    const session = await openSession(filename);
    try { await body(session, filename); } finally { await closeSession(session, filename); }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function mcpRecall(payload: unknown): RecallOut {
  const body = payload as { ok?: boolean; output?: SoulInterpretationResponse };
  if (body.ok !== true || body.output?.operation !== "recall") {
    throw new Error(`public soul.interpretation recall expected: ${JSON.stringify(payload)}`);
  }
  return body.output;
}

it("occupies one gold record identity for the same source with and without correspondence", async () => {
  await withHost([{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }], async (session) => {
    const prepared = await prepareSource(session.handler, session.context, "artifact-alice");
    const published = await proposeDraft(session.handler, session.context, prepared.source_handle,
      receiveInterpretation(ALICE, "artifact-alice", compactUse(prepared.catalog)).draft, "p1");
    const semantics = receiveQuerySemantics(ORIGINAL, existentialBody()).query;
    const semantic_correspondence = receiveCorrespondence(semantics, published.interpretation, published.interpretation_id).semantic_correspondence;
    const withCorrespondence = await workerRecall(session, semantics, [semantic_correspondence]);
    const withoutCorrespondence = await workerRecall(session, semantics, []);
    const proofSlot = withCorrespondence.slot_qualifiers.find((row) => row.evidence_kind === "semantic_proof" && row.source_interpretation_id === published.interpretation_id);
    const proofEntry = proofSlot === undefined ? undefined : withCorrespondence.index.entries[proofSlot.index];
    const fallback = withoutCorrespondence.index.entries.find((entry) => entry.target.kind === "source_evidence"
      && entry.target.root_id === published.source_target.root_id);
    expect(published.source_target.root_id).not.toBe("artifact-alice");
    expect(proofEntry?.target.kind).toBe("source_evidence");
    if (proofEntry?.target.kind !== "source_evidence" || fallback?.target.kind !== "source_evidence") {
      throw new Error("both slots must be source evidence");
    }
    expect(sourceGoldRootIdentity(proofEntry.target)).toBe(sourceGoldRootIdentity(fallback.target));
    const provedTarget = proofEntry.target;
    const occupied = withCorrespondence.index.entries.filter((entry) => entry.target.kind === "source_evidence"
      && sourceGoldRootIdentity(entry.target) === sourceGoldRootIdentity(provedTarget));
    expect(occupied).toHaveLength(1);
  });
}, 60000);

it("binds the surviving semantic_correspondence closure when two legal semantic correspondences on one source interpretation swap order", async () => {
  await withHost([{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }], async (session) => {
    const prepared = await prepareSource(session.handler, session.context, "artifact-alice");
    const published = await proposeDraft(session.handler, session.context, prepared.source_handle,
      receiveInterpretation(ALICE, "artifact-alice", compactUse(prepared.catalog)).draft, "p1");
    const semantics = receiveQuerySemantics(ORIGINAL, existentialBody()).query;
    const firstCorrespondence = receiveCorrespondence(semantics, published.interpretation, published.interpretation_id).semantic_correspondence;
    const rows = useCorrespondences(published.interpretation);
    const secondCorrespondence = receiveCorrespondence(semantics, published.interpretation, published.interpretation_id, {
      correspondences: [rows[3]!, rows[0]!, rows[1]!, rows[2]!]
    }).semantic_correspondence;
    const admittedFirst = admitSourceSemanticCorrespondence({
      semantic_correspondence: firstCorrespondence, source_interpretation: published.interpretation, query_semantics: semantics, original_query: ORIGINAL
    });
    const admittedSecond = admitSourceSemanticCorrespondence({
      semantic_correspondence: secondCorrespondence, source_interpretation: published.interpretation, query_semantics: semantics, original_query: ORIGINAL
    });
    expect(admittedFirst.kind).toBe("admitted");
    expect(admittedSecond.kind).toBe("admitted");
    if (admittedFirst.kind !== "admitted" || admittedSecond.kind !== "admitted") throw new Error("both correspondences must admit");
    expect(admittedFirst.semantic_correspondence_id).not.toBe(admittedSecond.semantic_correspondence_id);
    const forward = await workerRecall(session, semantics, [firstCorrespondence, secondCorrespondence]);
    const swapped = await workerRecall(session, semantics, [secondCorrespondence, firstCorrespondence]);
    const forwardSlot = forward.slot_qualifiers.find((row) => row.evidence_kind === "semantic_proof");
    const swappedSlot = swapped.slot_qualifiers.find((row) => row.evidence_kind === "semantic_proof");
    expect(forward.discovery.omitted_duplicate_bindings).toBeGreaterThan(0);
    expect(forwardSlot?.semantic_correspondence_id).toBeDefined();
    expect(forwardSlot?.conditional_computation_id).toBeDefined();
    expect(forwardSlot?.semantic_correspondence_id).toBe(swappedSlot?.semantic_correspondence_id);
    expect(forwardSlot?.conditional_computation_id).toBe(swappedSlot?.conditional_computation_id);
    const ids = [admittedFirst.semantic_correspondence_id, admittedSecond.semantic_correspondence_id];
    expect(ids).toContain(forwardSlot?.semantic_correspondence_id);
    const unselected = ids.find((id) => id !== forwardSlot?.semantic_correspondence_id);
    expect(unselected).toBeDefined();
    expect((forward.proofs ?? []).some((row) => row.semantic_correspondence_id === unselected)).toBe(false);
    expect((swapped.proofs ?? []).some((row) => row.semantic_correspondence_id === unselected)).toBe(false);
    expect(forward.index.entries[forwardSlot!.index]?.hypothesis_id).toBe(forwardSlot?.conditional_computation_id);
  });
}, 60000);

it("accepts eleven duplicate semantic_correspondences without overflowing proofs", async () => {
  await withHost([{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }], async (session) => {
    const prepared = await prepareSource(session.handler, session.context, "artifact-alice");
    const published = await proposeDraft(session.handler, session.context, prepared.source_handle,
      receiveInterpretation(ALICE, "artifact-alice", compactUse(prepared.catalog)).draft, "p1");
    const semantics = receiveQuerySemantics(ORIGINAL, existentialBody()).query;
    const semantic_correspondence = receiveCorrespondence(semantics, published.interpretation, published.interpretation_id).semantic_correspondence;
    const recalled = await workerRecall(session, semantics, Array.from({ length: 11 }, () => semantic_correspondence));
    expect(recalled.kind).toBe("recall");
    expect((recalled.proofs ?? []).length).toBeGreaterThan(0);
    expect((recalled.proofs ?? []).length).toBeLessThanOrEqual(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
    const rows = (recalled.proofs ?? []).map((row) => `${row.source_interpretation_id}:${row.semantic_correspondence_id}`);
    expect(new Set(rows).size).toBe(rows.length);
  });
}, 60000);

it("does not resurrect an erased current source as evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-host-erase-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSources(filename, [{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }]);
    const current = await admitSources(filename, [{
      id: "artifact-alice", content: "Alice uses nothing.", version: "2", recordedAt: "2026-09-19T00:00:00.000Z"
    }]);
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      const eraser = new SqliteFieldEraseBarrierRepo(database, fieldContractSha256);
      const subjectId = current["artifact-alice"]!;
      eraser.apply({
        identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", subjectId, ""], fieldContractSha256),
        barrier_id: "erase-host-path-current-source", workspace_id: WS, generation_id: null,
        subject_kind: "source_record", subject_id: subjectId, erased_at: CLOCK
      });
    } finally {
      database.close(); closeCachedDatabase(filename);
    }
    const session = await openSession(filename);
    try {
      const semantics = receiveQuerySemantics(ORIGINAL, existentialBody()).query;
      const recalled = await workerRecall(session, semantics, []);
      const search = soulSearchFromLibraryRecall(recalled);
      expect(search.results.some((row) => row.content_preview?.includes(ALICE))).toBe(false);
      expect(search.results.some((row) => row.content_preview?.includes("Alice uses nothing."))).toBe(false);
      expect(search.results.some((row) => row.content_preview?.includes(SILENT))).toBe(true);
    } finally {
      await closeSession(session, filename);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("does not claim complete public MCP payload after preview omission or shortening", async () => {
  expect(LONG.length).toBe(2001);
  await withHost([{ id: "artifact-long", content: LONG }, { id: "artifact-silent", content: SILENT }], async (session) => {
    const semantics = receiveQuerySemantics(ORIGINAL, existentialBody()).query;
    const worker = await workerRecall(session, semantics, []);
    const workerPreviews = Object.values(worker.previews ?? {});
    expect(workerPreviews.every((row) => row.length <= 4_096)).toBe(true);
    const mcp = await callAlayaMcpMemoryTool(
      { memoryToolHandler: session.handler, contextProvider: () => session.context },
      "soul.interpretation",
      SoulInterpretationRequestSchema.parse({
        operation: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        query_semantics: semantics, semantic_correspondences: [], budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES
      })
    );
    const publicRecall = mcpRecall(mcp.structuredContent);
    const publicRows = publicRecall.results ?? [];
    expect(publicRows.length).toBeGreaterThan(0);
    const altered = publicRows.some((row, offset) => {
      const entry = publicRecall.index?.entries[offset];
      const stored = entry === undefined ? undefined : worker.previews?.[indexEntryCacheKey(entry)];
      return row.content_preview === "[payload omitted]" || row.budget_state.within_budget === false
        || stored !== undefined && row.content_preview.length < stored.length;
    });
    expect(altered).toBe(true);
    expect(publicRecall.coverage.payload).not.toBe("complete");
  });
}, 60000);

it("proposes compact assertion-two raw through the prepared multi-sentence catalog", async () => {
  await withHost([{ id: "artifact-multi", content: MULTI }], async (session) => {
    const prepared = await prepareSource(session.handler, session.context, "artifact-multi");
    expect(prepared.catalog.assertions.map((row) => row.assertion_id)).toEqual([1, 2]);
    expect(segment(prepared.catalog, "remains", 2).startsWith("a2s")).toBe(true);
    const raw = {
      contract: "source-semantic-proposal-v4" as const,
      outcome: { status: "interpreted" as const },
      content: {
        roots: [{
          act: "assertion" as const,
          expression: {
            kind: "statement" as const,
            predicate: { kind: "explicit" as const, reading: "remain", at: segment(prepared.catalog, "remains", 2) },
            arguments: [{ role: "theme", target: segment(prepared.catalog, "clause", 2) }]
          }
        }]
      }
    };
    expect(JSON.stringify(raw)).toMatch(/a2s/);
    const draft = materializeSourceSemanticCompactProposal(raw).draft;
    expect(draft?.mentions.some((row) => row.source_ref.first.startsWith("a2s"))).toBe(true);
    const mcp = await callAlayaMcpMemoryTool(
      { memoryToolHandler: session.handler, contextProvider: () => session.context },
      "soul.interpretation",
      SoulInterpretationRequestSchema.parse({
        operation: "propose", source_handle: prepared.source_handle, draft,
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4",
        budget: BUDGET, authorized_scopes: SCOPES
      })
    );
    const payload = mcp.structuredContent as { ok?: boolean; output?: SoulInterpretationResponse };
    expect(payload.ok).toBe(true);
    expect(payload.output?.operation).toBe("propose");
    if (payload.output?.operation === "propose" && payload.output.outcome.status === "invalid") {
      expect(payload.output.outcome.reason).not.toBe("malformed_interpretation");
    }
    expect(payload.output?.operation === "propose" ? payload.output.outcome.status : undefined).toBe("interpreted");
    expect(payload.output?.operation === "propose" ? payload.output.published : undefined).toBeDefined();
  });
}, 60000);
