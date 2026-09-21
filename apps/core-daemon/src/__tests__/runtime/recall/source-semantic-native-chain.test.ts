import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema, hashLabeledIdentity,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticQuery, createAuditedSourceAdmission,
  createSourceSemanticInterpretationPublication, EvidenceService, fieldContractSha256,
  SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
  sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import {
  closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteFieldEraseBarrierRepo
} from "@do-soul/alaya-storage";
import { proposeAlignmentSemantics, proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
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
import {
  exposureSlots, firstExposureMismatch
} from "../../../../../../apps/bench-runner/src/runs/measurement/first-exposure-session.js";
import {
  recordSourceSemanticLibraryFirstExposure, soulSearchFromLibraryRecall
} from "../../../../../../apps/bench-runner/src/runs/measurement/source-semantic-library-recall.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const ALICE = "Alice uses tools.";
const SILENT = "Bob stays silent.";
const OTHER = "Alice stays home.";
const PROMISE = "Alice promised to send tools.";
const ORIGINAL = "which tools does Alice use?";
const UNIVERSAL = "every registered user uses tools";
const COMPARISON = "is Alice faster than Bob in ms in the lab";
const SENT = "which tools did Alice send?";
const BUDGET = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};
const SCOPES = { mode: "named" as const, scopes: ["project"] };

type Handler = ReturnType<typeof createMcpMemoryToolHandler>;
type Context = { workspaceId: string; runId: string; agentTarget: string; sessionId: string };

function segment(catalog: SourceReferenceCatalog, text: string, assertionId = 1): string {
  const assertion = catalog.assertions.find((row) => row.assertion_id === assertionId);
  const row = assertion?.segments.find((part) => part.text === text);
  if (row === undefined) {
    throw new Error(`catalog lacks ${text}: ${JSON.stringify(assertion?.segments.map((part) => part.text))}`);
  }
  return row.id;
}

function compactUse(catalog: SourceReferenceCatalog, extra: { gap?: boolean } = {}) {
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
      }],
      ...(extra.gap === true ? { gaps: [{ kind: "universal_quantification" as const, support: segment(catalog, "Alice"),
        description: "Nested universal binders remain unsupported." }] } : {})
    }
  };
}

function compactPromise(catalog: SourceReferenceCatalog) {
  return {
    contract: "source-semantic-proposal-v5" as const,
    outcome: { status: "interpreted" as const },
    content: {
      roots: [{
        act: "assertion" as const,
        expression: {
          kind: "statement" as const,
          predicate: { kind: "explicit" as const, reading: "promise", support: segment(catalog, "promised") },
          arguments: [
            { role: "promisor", target: segment(catalog, "Alice") },
            { role: "content", support: segment(catalog, "send"), target: {
              kind: "statement" as const,
              predicate: { kind: "explicit" as const, reading: "send", support: segment(catalog, "send") },
              arguments: [
                { role: "agent", target: segment(catalog, "Alice") },
                { role: "theme", target: segment(catalog, "tools") }
              ]
            } }
          ]
        }
      }]
    }
  };
}

function receiveH(source: string, sourceId: string, raw: object, producerVersion = "p1") {
  const received = proposeSourceSemantics({
    sourceCorpus: source, assertionIds: [1], source_id: sourceId, source_version: "1",
    producer_id: "test-author", producer_version: producerVersion
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
      { id: "tools", sort: "entity" as const }, { id: "fUse", sort: "proposition" as const }
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

function receiveQ(original: string, body: object) {
  const received = proposeQuerySemantics({
    original_query: original, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1",
    query_syntax: SOURCE_SEMANTIC_QUERY_CONTRACT,
  }, {
    rawJson: JSON.stringify({ contract: "source-semantic-query-response-v2", outcome: { status: "interpreted" }, query: body })
  });
  if (received.outcome.status !== "interpreted" || received.query === undefined) {
    throw new Error(`query receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { ...received, query: received.query };
}

function mention(h: SourceSemanticInterpretation, text: string) {
  const row = h.mentions.find((item) => item.text === text);
  if (row === undefined) throw new Error(`H lacks mention ${text}: ${h.mentions.map((item) => item.text).join(",")}`);
  return row;
}

function frameOf(h: SourceSemanticInterpretation, reading: string) {
  const row = h.frames.find((item) => item.predicate_support.reading === reading);
  if (row === undefined) throw new Error(`H lacks frame ${reading}`);
  return row;
}

function slotOf(h: SourceSemanticInterpretation, reading: string, role: string) {
  const row = frameOf(h, reading).slots.find((item) => item.role_reading === role);
  if (row === undefined) throw new Error(`H lacks ${role} on ${reading}`);
  return row;
}

function referentOf(h: SourceSemanticInterpretation, text: string) {
  const id = mention(h, text).id;
  const row = h.referents.find((item) => item.mentions.includes(id));
  if (row === undefined) throw new Error(`H lacks referent for ${text}`);
  return row;
}

function useCorrespondences(h: SourceSemanticInterpretation) {
  const actor = mention(h, "Alice"), tools = mention(h, "tools"), uses = mention(h, "uses");
  const frame = frameOf(h, "use");
  return [
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "referent" as const, variable: "actor" },
      source_endpoint: { kind: "referent" as const, referent: referentOf(h, "Alice").id },
      query_support: { kind: "query_text" as const, excerpt: "Alice" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [actor.id] }] },
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "slot" as const, alternative: 0, frame: "qUse", slot: "agent" },
      source_endpoint: { kind: "slot" as const, frame: frame.id, slot: slotOf(h, "use", "agent").id },
      query_support: { kind: "query_text" as const, excerpt: "Alice" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [actor.id] }] },
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "predicate" as const, alternative: 0, frame: "qUse" },
      source_endpoint: { kind: "frame" as const, frame: frame.id },
      query_support: { kind: "query_text" as const, excerpt: "use" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [uses.id] }] },
    { relation: "contextual_equivalence" as const, query_endpoint: { kind: "slot" as const, alternative: 0, frame: "qUse", slot: "theme" },
      source_endpoint: { kind: "slot" as const, frame: frame.id, slot: slotOf(h, "use", "theme").id },
      query_support: { kind: "query_text" as const, excerpt: "tools" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: [tools.id] }] }
  ];
}

function withoutNecessaryAgentBinding(
  draft: NonNullable<ReturnType<typeof receiveH>["draft"]>, h: SourceSemanticInterpretation
) {
  const agent = slotOf(h, "use", "agent").id;
  return {
    ...draft,
    frames: draft.frames.map((frame) => ({ ...frame, bindings: frame.bindings.filter((row) => row.slot_id !== agent) }))
  };
}

function receiveA(q: SourceSemanticQuery, h: SourceSemanticInterpretation, hId: string, extra: object = {}) {
  const received = proposeAlignmentSemantics({
    admitted_q: q, h_descriptors: [{ h_id: hId, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID, producer_version: "1",
    alignment_syntax: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-alignment-response-v2",
      outcome: { status: "interpreted", gaps: [] },
      alignment: { correspondences: useCorrespondences(h), ...extra }
    })
  });
  if (received.outcome.status !== "interpreted" || received.alignment === undefined) {
    throw new Error(`alignment receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { ...received, alignment: received.alignment };
}

async function admitSources(filename: string, sources: readonly { id: string; content: string; version?: string; recordedAt?: string }[]) {
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
  expect(database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
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
  const context: Context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "source-semantic-native-chain" };
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
  if (output.operation !== "prepare_source" || output.source_handle === undefined || output.catalog === undefined
    || output.source_id === undefined) {
    throw new Error("prepare_source must return a handle and catalog");
  }
  expect(output.provider_attempts).toBe(0);
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
  expect(output.provider_attempts).toBe(0);
  return output.published;
}

function queryHandleRecall(handler: Handler, context: Context, original: string, q: SourceSemanticQuery, alignments: object[]) {
  return callInterpretation(handler, {
    operation: "recall", accepts_unreviewed_conditional_results: true, original_query: original, q, alignments,
    budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES
  }, context);
}

it("preserves compact H and receiver Q/A through publish, reopen, MCP recall and first exposure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-native-chain-"));
  const filename = join(directory, "alaya.db");
  const started = Date.now();
  try {
    await admitSources(filename, [{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }]);
    const session = await openSession(filename);
    try {
      const prepared = await prepareSource(session.handler, session.context, "artifact-alice");
      const rawH = compactUse(prepared.catalog);
      const rawBytes = Buffer.byteLength(JSON.stringify(rawH));
      const receivedH = receiveH(ALICE, "artifact-alice", rawH);
      expect(receivedH.request.source_catalog.catalog_id).toBe(prepared.catalog.catalog_id);
      expect(receivedH.interpretation.source.source_id).toBe("artifact-alice");
      const published = await proposeDraft(session.handler, session.context, prepared.source_handle, receivedH.draft, "p1");
      expect(published.interpretation_id).toBeDefined();
      expect(published.interpretation.mentions.some((row) => row.id === "mAlice")).toBe(false);
      expect(session.database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
      const hId = published.interpretation_id;
      const hDigest = published.interpretation.source.content_digest;
      await closeSession(session, filename);

      const reopened = await openSession(filename);
      try {
        const receivedQ = receiveQ(ORIGINAL, existentialBody());
        expect(receivedQ.query.evaluation).toBeUndefined();
        const admittedQ = admitSourceSemanticQuery(receivedQ.query, ORIGINAL);
        expect(admittedQ.kind).toBe("admitted");
        const preparedQuery = await callInterpretation(reopened.handler, {
          operation: "prepare_query", original_query: ORIGINAL, q: receivedQ.query, budget: BUDGET, authorized_scopes: SCOPES
        }, reopened.context);
        if (preparedQuery.operation !== "prepare_query") throw new Error("prepare_query expected");
        expect(preparedQuery.provider_attempts).toBe(0);
        expect(preparedQuery.candidates.some((row) => row.interpretation_id === hId)).toBe(true);
        const receivedA = receiveA(receivedQ.query, published.interpretation, hId);
        expect(receivedA.alignment.h_id).toBe(hId);
        expect(receivedA.alignment.q_id).toBe(admittedQ.kind === "admitted" ? admittedQ.query_id : "");
        const wallStart = Date.now();
        const recalled = await queryHandleRecall(reopened.handler, reopened.context, ORIGINAL, receivedQ.query, [receivedA.alignment]);
        const wallMs = Date.now() - wallStart;
        const mcp = await callAlayaMcpMemoryTool(
          { memoryToolHandler: reopened.handler, contextProvider: () => reopened.context },
          "soul.interpretation",
          SoulInterpretationRequestSchema.parse({
            operation: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
            q: receivedQ.query, alignments: [receivedA.alignment], budget: BUDGET, output_byte_limit: 1_000_000,
            authorized_scopes: SCOPES
          })
        );
        if (recalled.operation !== "recall") throw new Error("library recall expected");
        expect(recalled.provider_attempts).toBe(0);
        expect((mcp.structuredContent as { output: { operation: string } }).output.operation).toBe("recall");
        expect(recalled.discovery?.eligible_source_count).toBeGreaterThanOrEqual(2);
        expect(recalled.order?.enumeration_policy).toBe("canonical");
        expect(recalled.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof" && row.h_id === hId)).toBe(true);
        const proof = recalled.proofs?.find((row) => row.h_id === hId);
        expect(proof?.consumed_leaves.some((row) => row.leaf_kind === "h_binding")).toBe(true);
        expect(proof?.world_claim).toBe("unknown");
        const search = soulSearchFromLibraryRecall(recalled);
        const goldSlot = recalled.slot_qualifiers?.find((row) => row.evidence_kind === "semantic_proof" && row.h_id === hId);
        expect(goldSlot).toBeDefined();
        expect(search.results.some((row) => row.content_preview?.includes("Alice uses tools."))).toBe(true);
        expect(search.results.some((row) => row.content_preview?.includes(SILENT) && row.object_kind === "source_evidence")).toBe(true);
        expect(search.results[goldSlot!.index]?.target.kind).toBe("source_evidence");
        const target = search.results[goldSlot!.index]?.target;
        if (target?.kind !== "source_evidence") throw new Error("source slot required");
        expect(target.root_id).toBe(published.source_target.root_id);
        expect(search.results.some((row) => row.object_kind === "memory_entry")).toBe(false);
        const page = recordSourceSemanticLibraryFirstExposure(recalled);
        expect(firstExposureMismatch(page, {
          query_id: search.index!.query_id, snapshot_id: search.index!.snapshot_id,
          interpretation_id: search.index!.interpretation_id!, as_of: search.index!.as_of!
        }, exposureSlots(search), search.delivery_id)).toBe(false);
        expect(page.initial?.scoring_slots[goldSlot!.index]?.rank).toBe(goldSlot!.index + 1);
        expect(recalled.work?.native_work).toBeGreaterThan(0);
        expect(recalled.work?.logical_memory_bytes).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(recalled))).toBeGreaterThan(0);
        expect(wallMs).toBeGreaterThanOrEqual(0);
        expect(rawBytes).toBeGreaterThan(0);
        expect(hDigest.startsWith("sha256:")).toBe(true);
        expect(Date.now() - started).toBeLessThan(60_000);

        const lostEvaluation = receiveQ(UNIVERSAL, {
          variables: [
            { id: "actor", sort: "entity" }, { id: "tools", sort: "entity" }, { id: "use", sort: "proposition" }
          ],
          alternatives: [{
            frames: [{
              id: "qUse", variable: "use", predicate_reading: "use",
              role_requirements: [
                { id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: "user" } },
                { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text", excerpt: "tools" } }
              ]
            }],
            context_obligations: [{ frame: "qUse", kind: "entailed_at_source" }]
          }],
          return_variables: [],
          gaps: [],
          domains: [{ id: "people", support: { kind: "query_text", excerpt: "registered user" } }],
          evaluation: { kind: "forall", domain: "people", binder: "actor", local_variables: ["actor", "tools", "use"] }
        });
        expect(lostEvaluation.query.evaluation?.kind).toBe("forall");
        expect(lostEvaluation.query.domains?.[0]?.id).toBe("people");
        const universalAdmitted = admitSourceSemanticQuery(lostEvaluation.query, UNIVERSAL);
        expect(universalAdmitted.kind).toBe("admitted");
        const universalRecall = await queryHandleRecall(reopened.handler, reopened.context, UNIVERSAL, lostEvaluation.query, []);
        if (universalRecall.operation !== "recall") throw new Error("universal recall expected");
        expect(universalRecall.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof")).toBe(false);
        const comparison = receiveQ(COMPARISON, {
          variables: [
            { id: "alice", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
            { id: "bob", sort: "entity", reference: { kind: "query_text", excerpt: "Bob" } }
          ],
          alternatives: [{ frames: [], context_obligations: [] }],
          return_variables: ["alice", "bob"],
          gaps: [],
          domains: [{ id: "people", support: { kind: "query_text", excerpt: "Alice" } }],
          evaluation: {
            kind: "comparison", domain: "people", operation: "gt", left: "alice", right: "bob",
            strict: true, metric: "speed", unit: "ms", context: "lab", scope: "asserted"
          }
        });
        expect(comparison.query.evaluation).toMatchObject({ kind: "comparison", unit: "ms", operation: "gt" });
        const compared = await queryHandleRecall(reopened.handler, reopened.context, COMPARISON, comparison.query, []);
        if (compared.operation !== "recall") throw new Error("comparison recall expected");
        expect(compared.provider_attempts).toBe(0);
        expect(compared.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof")).toBe(false);
        expect(compared.coverage?.computation).not.toBe("unexercised");

        const withoutA = await queryHandleRecall(reopened.handler, reopened.context, ORIGINAL, receivedQ.query, []);
        if (withoutA.operation !== "recall") throw new Error("A-absent recall expected");
        expect(withoutA.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof")).toBe(false);
        expect(soulSearchFromLibraryRecall(withoutA).results.some((row) => row.target.kind === "source_evidence"
          && row.target.kind === "source_evidence" && row.target.root_id === published.source_target.root_id)).toBe(true);
      } finally {
        await closeSession(reopened, filename);
      }
    } finally {
      try { await closeSession(session, filename); } catch { /* closed */ }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("discovers a compact-published interpretation after the first descriptor page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-native-page-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSources(filename, [{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }]);
    const session = await openSession(filename);
    try {
      const prepared = await prepareSource(session.handler, session.context, "artifact-alice");
      const receivedH = receiveH(ALICE, "artifact-alice", compactUse(prepared.catalog));
      const ids: string[] = [];
      for (let index = 0; index < 17; index += 1) {
        ids.push((await proposeDraft(session.handler, session.context, prepared.source_handle, receivedH.draft, `p${String(index + 1)}`)).interpretation_id);
      }
      await closeSession(session, filename);
      const reopened = await openSession(filename);
      try {
        const receivedQ = receiveQ(ORIGINAL, existentialBody());
        const preparedQuery = await callInterpretation(reopened.handler, {
          operation: "prepare_query", original_query: ORIGINAL, q: receivedQ.query, budget: BUDGET, authorized_scopes: SCOPES
        }, reopened.context);
        if (preparedQuery.operation !== "prepare_query") throw new Error("prepare_query expected");
        expect(preparedQuery.candidates.length).toBe(16);
        expect(preparedQuery.truncated).toBe(true);
        const gold = ids.find((id) => !preparedQuery.candidates.some((row) => row.interpretation_id === id));
        expect(gold).toBeDefined();
        const goldH = (await callInterpretation(reopened.handler, {
          operation: "prepare_query", original_query: ORIGINAL, q: receivedQ.query, budget: BUDGET, authorized_scopes: SCOPES,
          continuation_handle: preparedQuery.continuation_handle
        }, reopened.context));
        const descriptor = goldH.operation === "prepare_query"
          ? goldH.candidates.find((row) => row.interpretation_id === gold)
          : undefined;
        const interpretation = descriptor?.interpretation ?? receivedH.interpretation;
        const receivedA = receiveA(receivedQ.query, interpretation, gold!);
        const recalled = await queryHandleRecall(reopened.handler, reopened.context, ORIGINAL, receivedQ.query, [receivedA.alignment]);
        if (recalled.operation !== "recall") throw new Error("library recall expected");
        expect(recalled.discovery?.visited_h_pages).toBeGreaterThanOrEqual(2);
        expect(recalled.discovery?.visited_h_descriptors).toBeGreaterThan(16);
        expect(recalled.discovery?.examined_h_ids).toContain(gold);
        expect(recalled.discovery?.examined_h_ids).toHaveLength(1);
        expect(recalled.discovery?.unexamined_h_count).toBeGreaterThan(0);
        expect(recalled.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof" && row.h_id === gold)).toBe(true);
      } finally {
        await closeSession(reopened, filename);
      }
    } finally {
      try { await closeSession(session, filename); } catch { /* closed */ }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("retrieves promised source evidence without minting a completed-event proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-native-promise-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSources(filename, [{ id: "artifact-promise", content: PROMISE }, { id: "artifact-silent", content: SILENT }]);
    const session = await openSession(filename);
    try {
      const prepared = await prepareSource(session.handler, session.context, "artifact-promise");
      const receivedH = receiveH(PROMISE, "artifact-promise", compactPromise(prepared.catalog));
      expect(frameOf(receivedH.interpretation, "send").context_owner.kind).toBe("embedding");
      const published = await proposeDraft(session.handler, session.context, prepared.source_handle, receivedH.draft, "p1");
      await closeSession(session, filename);
      const reopened = await openSession(filename);
      try {
        const sendQ = receiveQ(SENT, {
          variables: [
            { id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
            { id: "tools", sort: "entity" }, { id: "fSend", sort: "proposition" }
          ],
          alternatives: [{
            frames: [{
              id: "qSend", variable: "fSend", predicate_reading: "send",
              role_requirements: [
                { id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: "Alice" } },
                { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text", excerpt: "tools" } }
              ]
            }],
            context_obligations: [{ frame: "qSend", kind: "asserted_at_source" }]
          }],
          return_variables: ["tools"],
          gaps: []
        });
        const sendFrame = frameOf(published.interpretation, "send");
        const receivedA = proposeAlignmentSemantics({
          admitted_q: sendQ.query, h_descriptors: [{ h_id: published.interpretation_id, interpretation: published.interpretation }],
          producer_id: SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID, producer_version: "1",
          alignment_syntax: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
        }, {
          rawJson: JSON.stringify({
            contract: "source-semantic-alignment-response-v2",
            outcome: { status: "interpreted", gaps: [] },
            alignment: {
              correspondences: [
                { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qSend" },
                  source_endpoint: { kind: "frame", frame: sendFrame.id },
                  query_support: { kind: "query_text", excerpt: "send" },
                  source_semantic_support: [{ kind: "lexical", mentions: [mention(published.interpretation, "send").id] }] },
                { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qSend", slot: "theme" },
                  source_endpoint: { kind: "slot", frame: sendFrame.id, slot: slotOf(published.interpretation, "send", "theme").id },
                  query_support: { kind: "query_text", excerpt: "tools" },
                  source_semantic_support: [{ kind: "lexical", mentions: [mention(published.interpretation, "tools").id] }] }
              ]
            }
          })
        });
        expect(receivedA.alignment).toBeDefined();
        const recalled = await queryHandleRecall(reopened.handler, reopened.context, SENT, sendQ.query, [receivedA.alignment!]);
        if (recalled.operation !== "recall") throw new Error("library recall expected");
        expect(recalled.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof")).toBe(false);
        expect(soulSearchFromLibraryRecall(recalled).results.some((row) => row.content_preview?.includes("promised"))).toBe(true);
      } finally {
        await closeSession(reopened, filename);
      }
    } finally {
      try { await closeSession(session, filename); } catch { /* closed */ }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("drops only dependent proof when a necessary H binding is withdrawn and isolates same-name entities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-native-identity-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSources(filename, [
      { id: "artifact-alice", content: ALICE }, { id: "artifact-other", content: OTHER }
    ]);
    const session = await openSession(filename);
    try {
      const alice = await prepareSource(session.handler, session.context, "artifact-alice");
      const other = await prepareSource(session.handler, session.context, "artifact-other");
      const full = receiveH(ALICE, "artifact-alice", compactUse(alice.catalog));
      const otherH = receiveH(OTHER, "artifact-other", {
        contract: "source-semantic-proposal-v5",
        outcome: { status: "interpreted" },
        content: {
          roots: [{
            act: "assertion",
            expression: {
              kind: "statement",
              predicate: { kind: "explicit", reading: "stay", support: segment(other.catalog, "stays") },
              arguments: [{ role: "agent", target: segment(other.catalog, "Alice") }]
            }
          }]
        }
      });
      const published = await proposeDraft(session.handler, session.context, alice.source_handle, full.draft, "p1");
      const withdrawn = await proposeDraft(
        session.handler, session.context, alice.source_handle,
        withoutNecessaryAgentBinding(full.draft, full.interpretation), "p-ablated"
      );
      const publishedOther = await proposeDraft(session.handler, session.context, other.source_handle, otherH.draft, "p1");
      expect(published.interpretation_id).not.toBe(publishedOther.interpretation_id);
      expect(published.interpretation.source.source_id).not.toBe(publishedOther.interpretation.source.source_id);
      await closeSession(session, filename);
      const reopened = await openSession(filename);
      try {
        const receivedQ = receiveQ(ORIGINAL, existentialBody());
        const withBinding = receiveA(receivedQ.query, published.interpretation, published.interpretation_id);
        const recalled = await queryHandleRecall(reopened.handler, reopened.context, ORIGINAL, receivedQ.query, [
          withBinding.alignment
        ]);
        const ablated = await queryHandleRecall(reopened.handler, reopened.context, ORIGINAL, receivedQ.query, [
          receiveA(receivedQ.query, withdrawn.interpretation, withdrawn.interpretation_id).alignment
        ]);
        if (recalled.operation !== "recall" || ablated.operation !== "recall") throw new Error("library recall expected");
        expect(recalled.slot_qualifiers?.some((row) => row.h_id === published.interpretation_id)).toBe(true);
        expect(ablated.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof")).toBe(false);
        expect(soulSearchFromLibraryRecall(ablated).results.some((row) => row.target.kind === "source_evidence" && row.target.root_id === published.source_target.root_id)).toBe(true);
        expect(recalled.slot_qualifiers?.some((row) => row.h_id === publishedOther.interpretation_id)).toBe(false);
        expect(soulSearchFromLibraryRecall(recalled).results.some((row) => row.content_preview?.includes("stays home"))).toBe(true);
      } finally {
        await closeSession(reopened, filename);
      }
    } finally {
      try { await closeSession(session, filename); } catch { /* closed */ }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("keeps a failed source available, records nested-binder gaps, and truncates honestly under a payload cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-native-degrade-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSources(filename, [{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }]);
    const session = await openSession(filename);
    try {
      const prepared = await prepareSource(session.handler, session.context, "artifact-alice");
      const gapped = receiveH(ALICE, "artifact-alice", compactUse(prepared.catalog, { gap: true }));
      expect(gapped.interpretation.gaps.some((row) => row.kind === "universal_quantification")).toBe(true);
      const published = await proposeDraft(session.handler, session.context, prepared.source_handle, gapped.draft, "p1");
      await closeSession(session, filename);
      const reopened = await openSession(filename);
      try {
        const receivedQ = receiveQ(ORIGINAL, existentialBody());
        const receivedA = receiveA(receivedQ.query, published.interpretation, published.interpretation_id);
        const full = await queryHandleRecall(reopened.handler, reopened.context, ORIGINAL, receivedQ.query, [receivedA.alignment]);
        if (full.operation !== "recall") throw new Error("full recall expected");
        expect(soulSearchFromLibraryRecall(full).results.some((row) => row.content_preview?.includes(SILENT))).toBe(true);
        const execute = reopened.client.sourceSemanticsPort!.execute;
        const workerFull = await execute({
          workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
          request: {
            kind: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
            q: receivedQ.query, alignments: [receivedA.alignment], budget: BUDGET, output_byte_limit: 1_000_000
          }
        });
        const workerBytes = Buffer.byteLength(JSON.stringify(workerFull));
        const workerLimited = await execute({
          workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
          request: {
            kind: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
            q: receivedQ.query, alignments: [receivedA.alignment], budget: BUDGET,
            output_byte_limit: Math.max(1024, workerBytes - 1)
          }
        });
        expect(workerLimited.kind).toBe("recall");
        if (workerLimited.kind !== "recall") throw new Error("limited worker recall expected");
        expect(workerLimited.coverage.payload === "truncated" || workerLimited.coverage.computation === "open").toBe(true);
        expect(soulSearchFromLibraryRecall(workerLimited).results.some((row) => row.object_kind === "memory_entry")).toBe(false);
        expect(full.provider_attempts).toBe(0);
      } finally {
        await closeSession(reopened, filename);
      }
    } finally {
      try { await closeSession(session, filename); } catch { /* closed */ }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("invalidates stale results after source update and recovers a pre-failure copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-native-lifecycle-"));
  const filename = join(directory, "alaya.db");
  const backup = join(directory, "alaya.copy.db");
  try {
    const identities = await admitSources(filename, [{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }]);
    const session = await openSession(filename);
    let hId = "";
    let q: SourceSemanticQuery | undefined;
    let alignment: object | undefined;
    try {
      const prepared = await prepareSource(session.handler, session.context, "artifact-alice");
      const receivedH = receiveH(ALICE, "artifact-alice", compactUse(prepared.catalog));
      const published = await proposeDraft(session.handler, session.context, prepared.source_handle, receivedH.draft, "p1");
      hId = published.interpretation_id;
      q = receiveQ(ORIGINAL, existentialBody()).query;
      alignment = receiveA(q, published.interpretation, hId).alignment;
      await closeSession(session, filename);
      await copyFile(filename, backup);
      for (const suffix of ["-wal", "-shm"]) {
        await copyFile(filename + suffix, backup + suffix).catch(() => undefined);
      }
    } finally {
      try { await closeSession(session, filename); } catch { /* closed */ }
    }
    await admitSources(filename, [
      { id: "artifact-alice", content: "Alice uses nothing.", version: "2", recordedAt: "2026-09-19T00:00:00.000Z" }
    ]);
    const updated = await openSession(filename);
    try {
      const stale = await queryHandleRecall(updated.handler, updated.context, ORIGINAL, q!, [alignment!]);
      if (stale.operation !== "recall") throw new Error("updated recall expected");
      expect(stale.slot_qualifiers?.some((row) => row.h_id === hId)).toBe(false);
    } finally {
      await closeSession(updated, filename);
    }
    const recovered = await openSession(backup);
    try {
      const replay = await queryHandleRecall(recovered.handler, recovered.context, ORIGINAL, q!, [alignment!]);
      if (replay.operation !== "recall") throw new Error("recovered recall expected");
      expect(replay.slot_qualifiers?.some((row) => row.evidence_kind === "semantic_proof" && row.h_id === hId)).toBe(true);
    } finally {
      await closeSession(recovered, backup);
    }
    const { database } = await createRecallRealStorage(() => undefined, backup);
    try {
      const eraser = new SqliteFieldEraseBarrierRepo(database, fieldContractSha256);
      const barrier = {
        identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", identities["artifact-alice"]!, ""], fieldContractSha256),
        barrier_id: "erase-semantic-source", workspace_id: WS, generation_id: null,
        subject_kind: "source_record" as const, subject_id: identities["artifact-alice"]!, erased_at: CLOCK
      };
      eraser.apply(barrier);
    } finally {
      database.close(); closeCachedDatabase(backup);
    }
    const erased = await openSession(backup);
    try {
      const afterErase = await queryHandleRecall(erased.handler, erased.context, ORIGINAL, q!, [alignment!]);
      if (afterErase.operation !== "recall") throw new Error("erased recall expected");
      expect(afterErase.slot_qualifiers?.some((row) => row.h_id === hId)).toBe(false);
      expect(soulSearchFromLibraryRecall(afterErase).results.some((row) => row.target.kind === "source_evidence"
        && sourceGoldRootIdentity(row.target).includes("artifact-alice"))).toBe(false);
    } finally {
      await closeSession(erased, backup);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
