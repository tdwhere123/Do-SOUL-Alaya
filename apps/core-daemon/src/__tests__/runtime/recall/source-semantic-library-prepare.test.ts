import { authoredQuerySemantics, correspondenceAssessmentJson } from "./source-semantic-producer-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  sourceSemanticInterpretationIdentity, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, EvidenceService,
  fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import {
  MAX_SOURCE_SEMANTIC_RESPONSE_BYTES, prepareSourceSemanticLibrary, proposeQuerySemantics, proposeSourceSemantics,
  sourceSemanticLibraryCorrespondenceCacheKey
} from "@do-soul/alaya-soul";
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

const CLOCK = "2026-09-18T00:00:00.000Z";
const ALICE = "Alice uses tools.";
const SILENT = "Bob stays silent.";
const ORIGINAL = "which tools does Alice use?";
const BUDGET = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};
const SCOPES = { mode: "named" as const, scopes: ["project"] };

type Handler = ReturnType<typeof createMcpMemoryToolHandler>;
type Context = { workspaceId: string; runId: string; agentTarget: string; sessionId: string };

function quote(catalog: SourceReferenceCatalog, text: string, assertionId = 1) {
  const assertion = catalog.assertions.find((row) => row.assertion_id === assertionId);
  const row = assertion?.segments.find((part) => part.text === text);
  if (row === undefined) {
    throw new Error(`catalog lacks ${text}: ${JSON.stringify(assertion?.segments.map((part) => part.text))}`);
  }
  return { assertion_id: assertionId, text: row.text };
}

function tableStatement(
  catalog: SourceReferenceCatalog, predicate: string, at: string,
  roles: readonly { role: string; text: string }[]
) {
  return {
    contract: "source-semantic-proposal-v8" as const,
    outcome: { status: "interpreted" as const },
    content: {
      roots: [{ act: "assertion" as const, expression: { kind: "content_ref" as const, key: "event" } }],
      entities: roles.map((row, index) => ({ form: "selection" as const, key: `entity${index}`,
        selection: quote(catalog, row.text) })),
      nodes: [{ kind: "statement" as const, key: "event",
        predicate: { kind: "explicit" as const, reading: predicate, support: quote(catalog, at) },
        arguments: roles.map((row, index) => ({ role: row.role,
          target: { kind: "entity_ref" as const, key: `entity${index}` } })), qualifications: [] }], gaps: []
    }
  };
}

function receiveInterpretation(source: string, sourceId: string, raw: object) {
  const received = proposeSourceSemantics({
    sourceCorpus: source, assertionIds: [1], source_id: sourceId, source_version: "1",
    producer_id: "test-author", producer_version: "p1"
  }, { rawJson: JSON.stringify(raw) });
  if (received.outcome.status !== "interpreted" || received.draft === undefined || received.interpretation === undefined) {
    throw new Error(`table receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { ...received, draft: received.draft, interpretation: received.interpretation };
}

function receiveQuerySemantics(original: string): SourceSemanticQuery {
  const received = authoredQuerySemantics({ original_query: original, producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
        variables: [
          { id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
          { id: "tools", sort: "entity" }, { id: "fUse", sort: "proposition" }
        ],
        alternatives: [{
          frames: [{
            id: "qUse", variable: "fUse", predicate_reading: "use",
            role_requirements: [
              { id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: "Alice" } },
              { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text", excerpt: "tools" } }
            ]
          }],
          context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }]
        }],
        return_variables: ["tools"],
        gaps: []
      });
  if (received.outcome.status !== "interpreted" || received.query === undefined) {
    throw new Error(`query receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.query;
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

function isGoldInterpretation(interpretation: SourceSemanticInterpretation): boolean {
  return interpretation.frames.some((row) => row.predicate_support.reading === "use")
    && interpretation.mentions.some((row) => row.text === "Alice")
    && interpretation.mentions.some((row) => row.text === "tools");
}

function goldCorrespondenceJson(interpretation: SourceSemanticInterpretation): string {
  const actor = mention(interpretation, "Alice"), tools = mention(interpretation, "tools"), uses = mention(interpretation, "uses");
  const frame = frameOf(interpretation, "use");
  return correspondenceAssessmentJson({ original_query: ORIGINAL, admitted_query_semantics: receiveQuerySemantics(ORIGINAL),
    source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256), interpretation: interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, {
      correspondences: [
        { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
          source_endpoint: { kind: "referent", referent: referentOf(interpretation, "Alice").id },
          query_support: { kind: "query_text", excerpt: "Alice" },
          source_semantic_support: [{ kind: "lexical", mentions: [actor.id] }] },
        { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "agent" },
          source_endpoint: { kind: "slot", frame: frame.id, slot: slotOf(interpretation, "use", "agent").id },
          query_support: { kind: "query_text", excerpt: "Alice" },
          source_semantic_support: [{ kind: "lexical", mentions: [actor.id] }] },
        { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
          source_endpoint: { kind: "frame", frame: frame.id },
          query_support: { kind: "query_text", excerpt: "use" },
          source_semantic_support: [{ kind: "lexical", mentions: [uses.id] }] },
        { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "theme" },
          source_endpoint: { kind: "slot", frame: frame.id, slot: slotOf(interpretation, "use", "theme").id },
          query_support: { kind: "query_text", excerpt: "tools" },
          source_semantic_support: [{ kind: "lexical", mentions: [tools.id] }] }
      ]
  });
}

async function admitSources(filename: string, sources: readonly { id: string; content: string }[]) {
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({
    stores, eventLogRepo, runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  });
  for (const source of sources) {
    await admission.admit({
      workspace_id: WS, source_id: source.id, source_version: "1", content_bytes: source.content,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(source.content)
    }, { workspaceId: WS });
  }
  database.close(); closeCachedDatabase(filename);
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
  const context: Context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "source-semantic-library-prepare" };
  const handler = createMcpMemoryToolHandler({
    ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort,
    sourceSemanticPublication: { publish: (input) => publication.publish(input) }
  });
  await client.ready();
  return { client, database, handler, context };
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

async function proposeDraft(handler: Handler, context: Context, sourceHandle: string, draft: unknown) {
  const output = await callInterpretation(handler, {
    operation: "propose", source_handle: sourceHandle, draft, producer_id: "test-author",
    producer_version: "p1", contract_version: "source-interpretation-v4",
    budget: BUDGET, authorized_scopes: SCOPES
  }, context);
  if (output.operation !== "propose" || output.published === undefined) {
    throw new Error(`propose failed: ${JSON.stringify(output.outcome)}`);
  }
  return output.published;
}

it("prepares bounded semantic correspondences from discovered source interpretation and recalls only harness semantic_correspondences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-library-prepare-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSources(filename, [{ id: "artifact-alice", content: ALICE }, { id: "artifact-silent", content: SILENT }]);
    const session = await openSession(filename);
    try {
      const alice = await prepareSource(session.handler, session.context, "artifact-alice");
      const silent = await prepareSource(session.handler, session.context, "artifact-silent");
      await proposeDraft(session.handler, session.context, alice.source_handle,
        receiveInterpretation(ALICE, "artifact-alice", tableStatement(alice.catalog, "use", "uses", [
          { role: "agent", text: "Alice" }, { role: "theme", text: "tools" }
        ])).draft);
      await proposeDraft(session.handler, session.context, silent.source_handle,
        receiveInterpretation(SILENT, "artifact-silent", tableStatement(silent.catalog, "stay", "stays", [
          { role: "agent", text: "Bob" }, { role: "theme", text: "silent" }
        ])).draft);
      const semantics = receiveQuerySemantics(ORIGINAL);
      const discovered = await callInterpretation(session.handler, {
        operation: "prepare_query", original_query: ORIGINAL, query_semantics: semantics, budget: BUDGET, authorized_scopes: SCOPES
      }, session.context);
      if (discovered.operation !== "prepare_query") throw new Error("prepare_query expected");
      const descriptors = discovered.candidates.flatMap((row) => {
        if (row.interpretation === undefined) return [];
        return [{ source_interpretation_id: row.interpretation_id, interpretation: row.interpretation }];
      });
      expect(descriptors.length).toBeGreaterThan(1);
      expect(descriptors.some((row) => isGoldInterpretation(row.interpretation))).toBe(true);
      expect(descriptors.some((row) => !isGoldInterpretation(row.interpretation))).toBe(true);
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider calls are forbidden"));
      try {
        let produceCalls = 0;
        const produce = (descriptor: (typeof descriptors)[number]) => {
          produceCalls += 1;
          if (isGoldInterpretation(descriptor.interpretation)) return { rawJson: goldCorrespondenceJson(descriptor.interpretation) };
          return { status: "no_correspondence" as const };
        };
        const prepared = prepareSourceSemanticLibrary({
          original_query: ORIGINAL, admitted_query_semantics: semantics, source_interpretation_descriptors: descriptors, produce,
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1"
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(produceCalls).toBe(descriptors.length);
        expect(prepared.outcomes).toHaveLength(descriptors.length);
        expect(prepared.outcomes.some((row) => row.status === "interpreted")).toBe(true);
        expect(prepared.outcomes.some((row) => row.status === "no_correspondence")).toBe(true);
        expect(prepared.semantic_correspondences).toHaveLength(1);
        const scopedFailure = {
          original_query: ORIGINAL, admitted_query_semantics: semantics,
          source_interpretation_descriptors: descriptors,
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1",
          correspondence_demand: { kind: "query_branches" as const, maximum_demands_per_interpretation: 1 },
          correspondence_cap: descriptors.length
        };
        const abstainedJson = JSON.stringify({ decision: "abstain", assessments: [] });
        const abstained = prepareSourceSemanticLibrary({ ...scopedFailure, produce: () => ({ rawJson: abstainedJson }) });
        expect(abstained.outcomes).toHaveLength(descriptors.length);
        expect(abstained.outcomes[0]).toMatchObject({
          status: "no_correspondence", outcome: { status: "abstained" }, rawJson: abstainedJson
        });
        expect(abstained.semantic_correspondences).toEqual([]);
        const oversized = "x".repeat(MAX_SOURCE_SEMANTIC_RESPONSE_BYTES + 1);
        const truncated = prepareSourceSemanticLibrary({ ...scopedFailure, produce: () => ({ rawJson: oversized }) });
        expect(truncated.outcomes[0]).toMatchObject({ status: "failed", outcome: { status: "truncated" } });
        expect(truncated.outcomes[0]?.raw_truncated).toBe(true);
        expect(truncated.outcomes[0]?.outcome).not.toMatchObject({ status: "invalid" });
        const invalidJson = JSON.stringify({ decision: "assess" });
        const invalid = prepareSourceSemanticLibrary({ ...scopedFailure, produce: () => ({ rawJson: invalidJson }) });
        expect(invalid.outcomes[0]).toMatchObject({ status: "invalid", rawJson: invalidJson });
        expect(invalid.outcomes[0]?.outcome?.status).toBe("invalid");
        const claimedHostJson = JSON.stringify({
          contract: "source-semantic-correspondence-response-v4", outcome: { status: "truncated" }
        });
        const claimedHost = prepareSourceSemanticLibrary({ ...scopedFailure, produce: () => ({ rawJson: claimedHostJson }) });
        expect(claimedHost.outcomes[0]?.status).toBe("invalid");
        expect(claimedHost.outcomes[0]?.outcome).not.toMatchObject({ status: "truncated" });
        const claimedExhaustedJson = JSON.stringify({ decision: "resource_exhausted", assessments: [] });
        const claimedExhausted = prepareSourceSemanticLibrary({
          ...scopedFailure, produce: () => ({ rawJson: claimedExhaustedJson })
        });
        expect(claimedExhausted.outcomes[0]?.status).toBe("invalid");
        expect(claimedExhausted.outcomes[0]?.outcome).not.toMatchObject({ status: "resource_exhausted" });
        let attempts = 0;
        const thrown = prepareSourceSemanticLibrary({ original_query: ORIGINAL, admitted_query_semantics: semantics,
          source_interpretation_descriptors: descriptors, produce: () => { attempts += 1; throw new Error("transport down"); }, cap: 1,
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" });
        expect(attempts).toBe(1);
        expect(thrown.outcomes[0]).toMatchObject({ status: "failed", outcome: { status: "transport_failure" } });
        expect(thrown.outcomes.slice(1).every((row) => row.status === "unattempted")).toBe(true);
        const forbidden = vi.fn(() => ({ status: "no_correspondence" as const }));
        for (const cap of [NaN, Infinity, -1, 1.5]) expect(() => prepareSourceSemanticLibrary({
          original_query: ORIGINAL, admitted_query_semantics: semantics, source_interpretation_descriptors: descriptors, produce: forbidden, cap,
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1"
        })).toThrow(/cap/u);
        expect(() => prepareSourceSemanticLibrary({ original_query: "different", admitted_query_semantics: semantics,
          source_interpretation_descriptors: descriptors, produce: forbidden, producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
          producer_version: "1" })).toThrow(/original query/u);
        expect(forbidden).not.toHaveBeenCalled();
        const interpreted = prepared.outcomes.find((row) => row.status === "interpreted");
        expect(interpreted?.source_interpretation_id).toBe(prepared.semantic_correspondences[0]?.source_interpretation_id);
        expect(prepared.cache[sourceSemanticLibraryCorrespondenceCacheKey(
          prepared.semantic_correspondences[0]!.query_semantics_id, prepared.semantic_correspondences[0]!.source_interpretation_id
        )]?.rawJson).toBe(goldCorrespondenceJson(descriptors.find((row) => row.source_interpretation_id === interpreted?.source_interpretation_id)!.interpretation));
        for (const outcome of prepared.outcomes) {
          if (outcome.status === "interpreted") continue;
          expect(prepared.cache[sourceSemanticLibraryCorrespondenceCacheKey(prepared.semantic_correspondences[0]!.query_semantics_id, outcome.source_interpretation_id)])
            .toBeUndefined();
        }
        const capped = prepareSourceSemanticLibrary({
          original_query: ORIGINAL, admitted_query_semantics: semantics, source_interpretation_descriptors: descriptors, produce, cap: 1,
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1"
        });
        expect(capped.outcomes[0]?.status).not.toBe("unattempted");
        expect(capped.outcomes.slice(1).every((row) => row.status === "unattempted")).toBe(true);
        expect(capped.outcomes.some((row) => row.status === "unattempted")).toBe(true);
        const recalled = await session.client.sourceSemanticsPort!.execute({
          workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
          request: {
            kind: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
            query_semantics: semantics, semantic_correspondences: prepared.semantic_correspondences, budget: BUDGET, output_byte_limit: 1_000_000
          }
        });
        if (recalled.kind !== "recall") throw new Error("library recall expected");
        expect(recalled.discovery.examined_source_interpretation_ids).toEqual(prepared.semantic_correspondences.map((row) => row.source_interpretation_id));
        expect(recalled.discovery.unexamined_source_interpretation_count).toBeGreaterThan(0);
        expect(recalled.slot_qualifiers.some((row) => row.evidence_kind === "semantic_proof"
          && row.source_interpretation_id === prepared.semantic_correspondences[0]?.source_interpretation_id)).toBe(true);
      } finally {
        fetch.mockRestore();
      }
    } finally {
      await closeSession(session, filename);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
