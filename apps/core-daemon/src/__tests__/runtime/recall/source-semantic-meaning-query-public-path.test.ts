import { queryWire, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery,
  type SourceSemanticDraft,
  SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
  UTTERANCE_ATTRIBUTION_CONTRACT, type UtteranceAttribution, sourceSemanticQueryIdentity
} from "@do-soul/alaya-protocol";
import {
  createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, EvidenceService,
  fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { proposeCorrespondenceSemantics, proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
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

const CLOCK = "2026-09-21T10:00:00.000Z";
const SOURCE = "Ada can operate the lathe.";
const ORIGINAL = "Whose operation of the lathe is represented as possible?";
const BUDGET = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};
const SCOPES = { mode: "named" as const, scopes: ["project"] };
const SOURCE_ATTRIBUTION: UtteranceAttribution = { contract: UTTERANCE_ATTRIBUTION_CONTRACT,
  status: "captured", issuer_scope: "authored-harness", utterances: [{ occurrence_id: "source-utterance",
    utf8_span: [0, Buffer.byteLength(SOURCE)], conversation_ref: "conversation-1", author_ref: "person-1" }] };
const QUERY_ATTRIBUTION: UtteranceAttribution = { contract: UTTERANCE_ATTRIBUTION_CONTRACT,
  status: "captured", issuer_scope: "authored-harness", utterances: [{ occurrence_id: "query-utterance",
    utf8_span: [0, Buffer.byteLength(ORIGINAL)], conversation_ref: "conversation-1", author_ref: "person-1" }] };

/** Contract-migrated meaning fixture for the model response receiver. */
const FROZEN_MEANING_RAW = queryWire(JSON.stringify({
  contract: "source-semantic-query-response-v8",
  outcome: { status: "interpreted", gaps: [] },
  query: {
    contract: "source-semantic-query-meaning-v5",
    alternatives: [{ conditions: [{
      kind: "possible", key: "q1",
      content: {
        kind: "statement", key: "s1", predicate: "operate",
        arguments: [
          { role: "agent", target: { kind: "free", key: "person", return: true }, excerpt: "Whose" },
          { role: "theme", target: { kind: "named", key: "lathe", excerpt: "lathe" }, excerpt: "lathe" }
        ]
      }
    }], evidence_inputs: [{ conditions: [{ kind: "occurrence", key: "s1" }] }] }],
    requested_operation: { reading: "identify the agent of the possible operation", support: { kind: "query_text", excerpt: ORIGINAL } },
    gaps: [],
    entities: [{ kind: "named", key: "lathe", excerpt: "lathe" }]
  }
}));

type Handler = ReturnType<typeof createMcpMemoryToolHandler>;
type Context = { workspaceId: string; runId: string; agentTarget: string; sessionId: string };

function quote(catalog: SourceReferenceCatalog, text: string) {
  const row = catalog.assertions[0]?.segments.find((part) => part.text === text);
  if (row === undefined) throw new Error(`catalog lacks ${text}`);
  return { assertion_id: catalog.assertions[0]!.assertion_id, text: row.text };
}

function mention(sourceInterpretation: SourceSemanticInterpretation, text: string) {
  const row = sourceInterpretation.mentions.find((item) => item.text === text);
  if (row === undefined) throw new Error(`source interpretation lacks ${text}`);
  return row;
}

function frameOf(sourceInterpretation: SourceSemanticInterpretation, reading: string) {
  const row = sourceInterpretation.frames.find((item) => item.predicate_support.reading === reading);
  if (row === undefined) throw new Error(`source interpretation lacks frame ${reading}`);
  return row;
}

function referentOf(sourceInterpretation: SourceSemanticInterpretation, text: string) {
  const id = mention(sourceInterpretation, text).id;
  const row = sourceInterpretation.referents.find((item) => item.mentions.includes(id));
  if (row === undefined) throw new Error(`source interpretation lacks referent for ${text}`);
  return row;
}

async function admitSource(filename: string, content = SOURCE, sourceId = "artifact-lathe",
  attribution?: UtteranceAttribution): Promise<void> {
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({
    stores, eventLogRepo, runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  });
  await admission.admit({
    workspace_id: WS, source_id: sourceId, source_version: "1", content_bytes: content,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(content),
    ...(attribution === undefined ? {} : { attribution_context: attribution })
  }, { workspaceId: WS });
  database.close();
  closeCachedDatabase(filename);
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
  const context: Context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "meaning-query-public-path" };
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

async function interpret(handler: Handler, args: unknown, context: Context) {
  const result = await handler.call({
    toolName: "soul.interpretation", arguments: SoulInterpretationRequestSchema.parse(args), context
  });
  if (!result.ok) throw new Error(`soul.interpretation failed: ${JSON.stringify(result)}`);
  return SoulInterpretationResponseSchema.parse(result.output);
}

function receiveFrozenQuerySemantics(attribution?: UtteranceAttribution) {
  const received = proposeQuerySemantics({
    original_query: ORIGINAL,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
    producer_version: "1",
    ...(attribution === undefined ? {} : { attribution_context: attribution })
  }, { rawJson: FROZEN_MEANING_RAW });
  if (received.outcome.status !== "interpreted" || received.query === undefined) {
    throw new Error(`query semantics receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { request: received.request, query: received.query };
}

function receiveLatheCorrespondence(querySemantics: SourceSemanticQuery, sourceInterpretation: SourceSemanticInterpretation, sourceInterpretationId: string) {
  const operate = frameOf(sourceInterpretation, "operate");
  const compiled = querySemantics.alternatives[0]?.frames.find((row) => row.predicate_reading === "operate");
  const agent = compiled?.role_requirements.find((row) => row.role_reading === "agent");
  const theme = compiled?.role_requirements.find((row) => row.role_reading === "theme");
  const operateAgent = operate.slots.find((row) => row.role_reading === "agent");
  const operateTheme = operate.slots.find((row) => row.role_reading === "theme");
  if (compiled === undefined || agent === undefined || theme === undefined
    || operateAgent === undefined || operateTheme === undefined) {
    throw new Error("compiled operate slots required");
  }
  const received = receiveAuthoredCorrespondence({ original_query: ORIGINAL, admitted_query_semantics: querySemantics, source_interpretation_descriptors: [{ source_interpretation_id: sourceInterpretationId, interpretation: sourceInterpretation }], producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences: [
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "referent", variable: "lathe" },
          source_endpoint: { kind: "referent", referent: referentOf(sourceInterpretation, "lathe").id },
          query_support: { kind: "query_text", excerpt: "lathe" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(sourceInterpretation, "lathe").id] }] },
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "predicate", alternative: 0, frame: compiled.id },
          source_endpoint: { kind: "frame", frame: operate.id },
          query_support: { kind: "query_text", excerpt: "operation" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(sourceInterpretation, "operate").id] }] },
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "slot", alternative: 0, frame: compiled.id, slot: agent.id },
          source_endpoint: { kind: "slot", frame: operate.id, slot: operateAgent.id },
          query_support: { kind: "query_text", excerpt: "Whose" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(sourceInterpretation, "Ada").id] }] },
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "slot", alternative: 0, frame: compiled.id, slot: theme.id },
          source_endpoint: { kind: "slot", frame: operate.id, slot: operateTheme.id },
          query_support: { kind: "query_text", excerpt: "lathe" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(sourceInterpretation, "lathe").id] }] }
      ] }, { status: "interpreted", gaps: [] });
  if (received.semantic_correspondence === undefined) {
    throw new Error(`Correspondence receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.semantic_correspondence;
}

/**
 * Handbook (`docs/handbook/recall.md`): `soul.interpretation` `recall` is the
 * opt-in typed source interpretation, query semantics, and semantic correspondence library path. Ordinary `soul.recall` is not that surface.
 */
it("recalls admitted query meaning through SQLite reopen, worker, and public interpretation", async () => {
  const receivedQuerySemantics = receiveFrozenQuerySemantics(QUERY_ATTRIBUTION);
  expect(receivedQuerySemantics.request.contract).toBe("source-semantic-query-request-v9");
  expect(receivedQuerySemantics.query.alternatives[0]?.frames.some((row) => row.operator === "possible")).toBe(true);

  const directory = await mkdtemp(join(tmpdir(), "source-semantic-meaning-public-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSource(filename, SOURCE, "artifact-lathe", SOURCE_ATTRIBUTION);
    const session = await openSession(filename);
    let sourceInterpretationId: string;
    let sourceInterpretation: SourceSemanticInterpretation;
    let sourceDraft: SourceSemanticDraft;
    try {
      const prepared = await interpret(session.handler, {
        operation: "prepare_source", source_id: "artifact-lathe", budget: BUDGET, authorized_scopes: SCOPES
      }, session.context);
      if (prepared.operation !== "prepare_source" || prepared.catalog === undefined || prepared.source_handle === undefined) {
        throw new Error("prepare_source required");
      }
      const catalog = prepared.catalog;
      const receivedInterpretation = proposeSourceSemantics({
        sourceCorpus: SOURCE, assertionIds: [1], source_id: "artifact-lathe", source_version: "1",
        producer_id: "test-author", producer_version: "p1", attribution_context: SOURCE_ATTRIBUTION
      }, {
        rawJson: JSON.stringify({
          contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" },
          content: { roots: [{ act: "assertion", expression: {
            kind: "possible", support: quote(catalog, "can"),
            content: {
              kind: "statement",
              predicate: { kind: "explicit", reading: "operate", support: quote(catalog, "operate") },
              arguments: [
                { role: "agent", target: quote(catalog, "Ada") },
                { role: "theme", target: quote(catalog, "lathe") }
              ]
            }
          } }] }
        })
      });
      if (receivedInterpretation.draft === undefined || receivedInterpretation.interpretation === undefined) {
        throw new Error(`source-interpretation receive failed: ${JSON.stringify(receivedInterpretation.outcome)}`);
      }
      sourceDraft = receivedInterpretation.draft;
      const published = await interpret(session.handler, {
        operation: "propose", source_handle: prepared.source_handle, draft: receivedInterpretation.draft,
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4",
        budget: BUDGET, authorized_scopes: SCOPES
      }, session.context);
      if (published.operation !== "propose" || published.published === undefined) {
        throw new Error(`propose failed: ${JSON.stringify(published.outcome)}`);
      }
      sourceInterpretationId = published.published.interpretation_id;
      sourceInterpretation = published.published.interpretation;
    } finally {
      await closeSession(session, filename);
    }

    const reopened = await openSession(filename);
    try {
      const admitted = receiveFrozenQuerySemantics(QUERY_ATTRIBUTION);
      expect(admitted.request.contract).toBe("source-semantic-query-request-v9");
      const querySemanticsAfter = admitted.query;
      const semantic_correspondence = receiveLatheCorrespondence(querySemanticsAfter, sourceInterpretation, sourceInterpretationId);
      const recalled = await interpret(reopened.handler, {
        operation: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        query_semantics: querySemanticsAfter, semantic_correspondences: [semantic_correspondence], budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES
      }, reopened.context);
      if (recalled.operation !== "recall") throw new Error(`recall expected: ${JSON.stringify(recalled)}`);
      expect(recalled.provider_attempts).toBe(0);
      const proofSlot = recalled.slot_qualifiers?.find((row) => row.evidence_kind === "semantic_proof" && row.source_interpretation_id === sourceInterpretationId);
      expect(proofSlot).toBeDefined();
      expect(recalled.proofs?.some((row) => row.source_interpretation_id === sourceInterpretationId && (row.binding_results?.length ?? 0) > 0)).toBe(true);
      const proof = recalled.proofs!.find(row => row.source_interpretation_id === sourceInterpretationId)!;
      expect(proof.source_record.attribution_context).toEqual(SOURCE_ATTRIBUTION);
      expect(proof.interpretation.source.attribution_context).toEqual(SOURCE_ATTRIBUTION);
      expect(proof.query.attribution_context).toEqual(QUERY_ATTRIBUTION);
      expect(proof.binding_results?.map(row => row.kind).sort()).toEqual(["answer", "evidence"]);
      expect(proof.binding_results?.find(row => row.kind === "evidence")?.query_complete).toBe(false);
      expect(proofSlot!.witnesses).toHaveLength(2);
      expect(proofSlot!.support).toMatchObject({ answer: "supported", evidence_inputs: [{ alternative: 0, input: 0, status: "supported" }],
        operation: "not_executed", compatibility: "unknown", distinctness: "unknown" });
      expect(recalled.results?.[proofSlot!.index]?.object_kind).toBe("semantic_proof");
      expect(recalled.delivery_id).toEqual(expect.any(String));
      const otherQueryAttribution: UtteranceAttribution = { ...QUERY_ATTRIBUTION, status: "captured",
        utterances: [{ ...QUERY_ATTRIBUTION.utterances[0]!, author_ref: "person-2" }] };
      const shifted = receiveFrozenQuerySemantics(otherQueryAttribution);
      expect(sourceSemanticQueryIdentity(shifted.query, fieldContractSha256)).not.toBe(
        sourceSemanticQueryIdentity(querySemanticsAfter, fieldContractSha256));
      const staleCorrespondence = await interpret(reopened.handler, {
        operation: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        query_semantics: shifted.query, semantic_correspondences: [semantic_correspondence],
        budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES
      }, reopened.context);
      expect(staleCorrespondence.operation).toBe("recall");
      if (staleCorrespondence.operation === "recall") expect(staleCorrespondence.proofs ?? []).toEqual([]);
      const staleSource = await interpret(reopened.handler, { operation: "prepare_source",
        source_id: "artifact-lathe", budget: BUDGET, authorized_scopes: SCOPES }, reopened.context);
      if (staleSource.operation !== "prepare_source" || staleSource.source_handle === undefined) {
        throw new Error("source handle required for correction control");
      }
      const correctedAttribution: UtteranceAttribution = { ...SOURCE_ATTRIBUTION, status: "captured",
        utterances: [{ ...SOURCE_ATTRIBUTION.utterances[0]!, author_ref: "person-2" }] };
      const stores = createSqliteFieldFormationStores({ database: reopened.database,
        repos: createDaemonFieldRepos({ database: reopened.database }) });
      await createAuditedSourceAdmission({ stores, eventLogRepo: new SqliteEventLogRepo(reopened.database),
        runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 }).admit({
          workspace_id: WS, source_id: "artifact-lathe", source_version: "2", content_bytes: SOURCE,
          evidence_object_id: null, recorded_at: "2026-09-21T10:00:01.000Z", event_time: null,
          valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
          attribution_context: correctedAttribution, spans: deriveAddressableSpanViews(SOURCE)
        }, { workspaceId: WS });
      const stalePublication = await interpret(reopened.handler, { operation: "propose",
        source_handle: staleSource.source_handle, draft: sourceDraft!, producer_id: "test-author",
        producer_version: "p1", contract_version: "source-interpretation-v4",
        budget: BUDGET, authorized_scopes: SCOPES }, reopened.context);
      expect(stalePublication.operation).toBe("propose");
      if (stalePublication.operation === "propose") expect(stalePublication.outcome).toMatchObject({
        status: "invalid", reason: "source_not_current" });
      const currentSource = await interpret(reopened.handler, { operation: "prepare_source",
        source_id: "artifact-lathe", budget: BUDGET, authorized_scopes: SCOPES }, reopened.context);
      expect(currentSource).toMatchObject({ operation: "prepare_source", source_version: "2",
        attribution_context: correctedAttribution });
      const oldProof = await interpret(reopened.handler, { operation: "recall",
        accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        query_semantics: querySemanticsAfter, semantic_correspondences: [semantic_correspondence],
        budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES }, reopened.context);
      if (oldProof.operation === "recall") expect(oldProof.proofs ?? []).toEqual([]);
    } finally {
      await closeSession(reopened, filename);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("requires the requested graduate's referent even when another graduate has the same agent role", async () => {
  const content = "Mara graduated with Biology; Theo earned a Physics degree.";
  const sourceId = "graduate-pair";
  const fixedQuestion = "What degree did Mara graduate with?";
  const freeQuestion = "What degree did someone graduate with?";
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-graduate-person-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSource(filename, content, sourceId);
    const session = await openSession(filename);
    let published: NonNullable<Extract<Awaited<ReturnType<typeof interpret>>, { operation: "propose" }>["published"]>;
    try {
      const prepared = await interpret(session.handler, {
        operation: "prepare_source", source_id: sourceId, budget: BUDGET, authorized_scopes: SCOPES
      }, session.context);
      if (prepared.operation !== "prepare_source" || prepared.catalog === undefined || prepared.source_handle === undefined) {
        throw new Error("prepare_source required");
      }
      const proposal = proposeSourceSemantics({ sourceCorpus: content, assertionIds: [1], source_id: sourceId,
        source_version: "1", producer_id: "test-author", producer_version: "p1" }, { rawJson: JSON.stringify({
          contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" },
          content: { roots: [
            { act: "assertion", expression: { kind: "statement", predicate: { kind: "explicit", reading: "graduate", support: quote(prepared.catalog, "graduated") },
              arguments: [{ role: "agent", target: quote(prepared.catalog, "Mara") },
                { role: "degree", target: quote(prepared.catalog, "Biology") }] } },
            { act: "assertion", expression: { kind: "statement", predicate: { kind: "explicit", reading: "graduate", support: quote(prepared.catalog, "earned") },
              arguments: [{ role: "agent", target: quote(prepared.catalog, "Theo") },
                { role: "degree", target: quote(prepared.catalog, "Physics") }] } }
          ] }
        }) });
      if (proposal.draft === undefined || proposal.interpretation === undefined) throw new Error(JSON.stringify(proposal.outcome));
      const result = await interpret(session.handler, { operation: "propose", source_handle: prepared.source_handle,
        draft: proposal.draft, producer_id: "test-author", producer_version: "p1",
        contract_version: "source-interpretation-v4", budget: BUDGET, authorized_scopes: SCOPES }, session.context);
      if (result.operation !== "propose" || result.published === undefined) throw new Error(JSON.stringify(result.outcome));
      published = result.published;
    } finally { await closeSession(session, filename); }

    const reopened = await openSession(filename);
    try {
      const interpretation = published!.interpretation;
      const mara = referentOf(interpretation, "Mara").id;
      const biology = referentOf(interpretation, "Biology").id;
      const physics = referentOf(interpretation, "Physics").id;
      expect(interpretation.frames.filter(row => row.predicate_support.reading === "graduate")).toHaveLength(2);
      const check = async (original_query: string, target: object, expected: string[], constrained: boolean) => {
        const received = proposeQuerySemantics({ original_query, producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
          producer_version: "1" }, { rawJson: queryWire(JSON.stringify({
            contract: "source-semantic-query-response-v8", outcome: { status: "interpreted" },
            query: { contract: "source-semantic-query-meaning-v5", gaps: [],
              alternatives: [{ conditions: [{ kind: "statement", predicate: "graduate", arguments: [
                { role: "agent", target },
                { role: "degree", target: { kind: "free", key: "degree", excerpt: "What degree", return: true } }
              ] }] }] }
          })) });
        if (received.query === undefined) throw new Error(JSON.stringify(received.outcome));
        const query = received.query;
        expect(query.variables.find(row => row.id === "actor")?.reference?.excerpt).toBe(constrained ? "Mara" : undefined);
        expect(query.variables.find(row => row.id === "degree")?.reference).toBeUndefined();
        const queryFrame = query.alternatives[0]!.frames[0]!;
        const rows = interpretation.frames.flatMap(frame => {
          if (frame.predicate_support.kind !== "explicit") throw new Error("explicit graduation predicate required");
          const agentSlot = frame.slots.find(row => row.role_reading === "agent")!.id;
          const degreeSlot = frame.slots.find(row => row.role_reading === "degree")!.id;
          const agent = frame.bindings.find(row => row.slot_id === agentSlot)!.target;
          const degree = frame.bindings.find(row => row.slot_id === degreeSlot)!.target;
          if (agent.kind !== "node" || degree.kind !== "node") throw new Error("grouped referents required");
          const support = (id: string) => [{ kind: "lexical" as const, mentions: [interpretation.referents.find(row => row.id === id)!.mentions[0]!] }];
          return [
            { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
              source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "graduate" },
              source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }] },
            { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: "agent" },
              source_endpoint: { kind: "slot", frame: frame.id, slot: agentSlot }, query_support: { kind: "query_text", excerpt: constrained ? "Mara" : "someone" },
              source_semantic_support: support(agent.id) },
            { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: "degree" },
              source_endpoint: { kind: "slot", frame: frame.id, slot: degreeSlot }, query_support: { kind: "query_text", excerpt: "degree" },
              source_semantic_support: support(degree.id) }
          ];
        });
        const referent = { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
          source_endpoint: { kind: "referent", referent: mara }, query_support: { kind: "query_text", excerpt: "Mara" },
          source_semantic_support: [{ kind: "lexical", mentions: referentOf(interpretation, "Mara").mentions }] };
        const correspondence = receiveAuthoredCorrespondence({ original_query, admitted_query_semantics: query,
          source_interpretation_descriptors: [{ source_interpretation_id: published!.interpretation_id, interpretation }],
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
        { correspondences: constrained ? [referent, ...rows] : rows }, { status: "interpreted", gaps: [] });
        if (correspondence.semantic_correspondence === undefined) throw new Error(JSON.stringify(correspondence.outcome));
        const recall = await interpret(reopened.handler, { operation: "recall", accepts_unreviewed_conditional_results: true,
          original_query, query_semantics: query, semantic_correspondences: [correspondence.semantic_correspondence],
          budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES }, reopened.context);
        if (recall.operation !== "recall") throw new Error("recall required");
        expect(recall.provider_attempts).toBe(0);
        const bindings = recall.proofs?.flatMap(proof => proof.binding_results ?? []) ?? [];
        expect(bindings.map(row => row.returned.degree?.node_id).sort()).toEqual(expected);
        if (constrained) {
          expect(bindings[0]?.bindings.actor?.node_id).toBe(mara);
          expect(bindings[0]?.query_complete).toBe(true);
          expect(recall.proofs?.[0]?.consumed_leaves.some(row => row.leaf_kind === "semantic_correspondence_referent")).toBe(true);
          const withoutReferent = receiveAuthoredCorrespondence({ original_query, admitted_query_semantics: query,
            source_interpretation_descriptors: [{ source_interpretation_id: published!.interpretation_id, interpretation }],
            producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
          { correspondences: rows }, { status: "interpreted", gaps: [] });
          if (withoutReferent.semantic_correspondence === undefined) throw new Error(JSON.stringify(withoutReferent.outcome));
          const withdrawn = await interpret(reopened.handler, { operation: "recall", accepts_unreviewed_conditional_results: true,
            original_query, query_semantics: query, semantic_correspondences: [withoutReferent.semantic_correspondence],
            budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES }, reopened.context);
          if (withdrawn.operation !== "recall") throw new Error("recall required");
          expect(withdrawn.proofs?.flatMap(proof => proof.binding_results ?? []) ?? []).toEqual([]);
        }
      };
      await check(fixedQuestion, { kind: "named", key: "actor", excerpt: "Mara" }, [biology], true);
      await check(freeQuestion, { kind: "free", key: "actor", excerpt: "someone" }, [biology, physics].sort(), false);
    } finally { await closeSession(reopened, filename); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
