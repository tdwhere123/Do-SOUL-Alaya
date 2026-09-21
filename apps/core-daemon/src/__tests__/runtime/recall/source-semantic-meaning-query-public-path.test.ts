import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticQuery,
  SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, EvidenceService,
  fieldContractSha256, SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { proposeAlignmentSemantics, proposeQuerySemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
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

/** Frozen contract-repair meaning raw. This is not a host-authored graph body. */
const FROZEN_MEANING_RAW = JSON.stringify({
  contract: "source-semantic-query-response-v3",
  outcome: { status: "interpreted", gaps: [] },
  query: {
    contract: "source-semantic-query-meaning-v1",
    alternatives: [{ meaning: {
      kind: "possible", key: "q1",
      content: {
        kind: "statement", key: "s1", predicate: "operate",
        arguments: [
          { role: "agent", target: { kind: "free", key: "person", return: true }, excerpt: "Whose" },
          { role: "theme", target: { kind: "named", key: "lathe", excerpt: "lathe" }, excerpt: "lathe" }
        ]
      }
    } }],
    gaps: [], return: ["person"],
    entities: [{ kind: "named", key: "lathe", excerpt: "lathe" }]
  }
});

type Handler = ReturnType<typeof createMcpMemoryToolHandler>;
type Context = { workspaceId: string; runId: string; agentTarget: string; sessionId: string };

function segment(catalog: SourceReferenceCatalog, text: string): string {
  const row = catalog.assertions[0]?.segments.find((part) => part.text === text);
  if (row === undefined) throw new Error(`catalog lacks ${text}`);
  return row.id;
}

function mention(h: SourceSemanticInterpretation, text: string) {
  const row = h.mentions.find((item) => item.text === text);
  if (row === undefined) throw new Error(`H lacks ${text}`);
  return row;
}

function frameOf(h: SourceSemanticInterpretation, reading: string) {
  const row = h.frames.find((item) => item.predicate_support.reading === reading);
  if (row === undefined) throw new Error(`H lacks frame ${reading}`);
  return row;
}

function referentOf(h: SourceSemanticInterpretation, text: string) {
  const id = mention(h, text).id;
  const row = h.referents.find((item) => item.mentions.includes(id));
  if (row === undefined) throw new Error(`H lacks referent for ${text}`);
  return row;
}

async function admitSource(filename: string): Promise<void> {
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({
    stores, eventLogRepo, runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  });
  await admission.admit({
    workspace_id: WS, source_id: "artifact-lathe", source_version: "1", content_bytes: SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE)
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

function receiveFrozenMeaningQ() {
  const received = proposeQuerySemantics({
    original_query: ORIGINAL,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
    producer_version: "1"
  }, { rawJson: FROZEN_MEANING_RAW });
  if (received.outcome.status !== "interpreted" || received.query === undefined) {
    throw new Error(`meaning Q receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return { request: received.request, query: received.query };
}

function receiveLatheA(q: SourceSemanticQuery, h: SourceSemanticInterpretation, hId: string) {
  const operate = frameOf(h, "operate");
  const compiled = q.alternatives[0]?.frames.find((row) => row.predicate_reading === "operate");
  const agent = compiled?.role_requirements.find((row) => row.role_reading === "agent");
  const theme = compiled?.role_requirements.find((row) => row.role_reading === "theme");
  const operateAgent = operate.slots.find((row) => row.role_reading === "agent");
  const operateTheme = operate.slots.find((row) => row.role_reading === "theme");
  if (compiled === undefined || agent === undefined || theme === undefined
    || operateAgent === undefined || operateTheme === undefined) {
    throw new Error("compiled operate slots required");
  }
  const received = proposeAlignmentSemantics({
    original_query: ORIGINAL, admitted_q: q,
    h_descriptors: [{ h_id: hId, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID, producer_version: "1",
    alignment_syntax: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-alignment-response-v2",
      outcome: { status: "interpreted", gaps: [] },
      alignment: { correspondences: [
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "referent", variable: "lathe" },
          source_endpoint: { kind: "referent", referent: referentOf(h, "lathe").id },
          query_support: { kind: "query_text", excerpt: "lathe" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(h, "lathe").id] }] },
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "predicate", alternative: 0, frame: compiled.id },
          source_endpoint: { kind: "frame", frame: operate.id },
          query_support: { kind: "query_text", excerpt: "operation" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(h, "operate").id] }] },
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "slot", alternative: 0, frame: compiled.id, slot: agent.id },
          source_endpoint: { kind: "slot", frame: operate.id, slot: operateAgent.id },
          query_support: { kind: "query_text", excerpt: "Whose" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(h, "Ada").id] }] },
        { relation: "contextual_equivalence",
          query_endpoint: { kind: "slot", alternative: 0, frame: compiled.id, slot: theme.id },
          source_endpoint: { kind: "slot", frame: operate.id, slot: operateTheme.id },
          query_support: { kind: "query_text", excerpt: "lathe" },
          source_semantic_support: [{ kind: "lexical", mentions: [mention(h, "lathe").id] }] }
      ] }
    })
  });
  if (received.alignment === undefined) {
    throw new Error(`A receive failed: ${JSON.stringify(received.outcome)}`);
  }
  return received.alignment;
}

/**
 * Handbook (`docs/handbook/recall.md`): `soul.interpretation` `recall` is the
 * opt-in typed H/Q/A library path. Ordinary `soul.recall` is not that surface.
 */
it("recalls a model-admitted meaning Q through SQLite reopen, worker, and public interpretation", async () => {
  const receivedQ = receiveFrozenMeaningQ();
  expect(receivedQ.request.contract).toBe("source-semantic-query-request-v3");
  expect(receivedQ.query.alternatives[0]?.frames.some((row) => row.operator === "possible")).toBe(true);

  const directory = await mkdtemp(join(tmpdir(), "source-semantic-meaning-public-"));
  const filename = join(directory, "alaya.db");
  try {
    await admitSource(filename);
    const session = await openSession(filename);
    let hId: string;
    let h: SourceSemanticInterpretation;
    try {
      const prepared = await interpret(session.handler, {
        operation: "prepare_source", source_id: "artifact-lathe", budget: BUDGET, authorized_scopes: SCOPES
      }, session.context);
      if (prepared.operation !== "prepare_source" || prepared.catalog === undefined || prepared.source_handle === undefined) {
        throw new Error("prepare_source required");
      }
      const catalog = prepared.catalog;
      const receivedH = proposeSourceSemantics({
        sourceCorpus: SOURCE, assertionIds: [1], source_id: "artifact-lathe", source_version: "1",
        producer_id: "test-author", producer_version: "p1"
      }, {
        rawJson: JSON.stringify({
          contract: "source-semantic-proposal-v5", outcome: { status: "interpreted" },
          content: { roots: [{ act: "assertion", expression: {
            kind: "possible", support: segment(catalog, "can"),
            content: {
              kind: "statement",
              predicate: { kind: "explicit", reading: "operate", support: segment(catalog, "operate") },
              arguments: [
                { role: "agent", target: segment(catalog, "Ada") },
                { role: "theme", target: segment(catalog, "lathe") }
              ]
            }
          } }] }
        })
      });
      if (receivedH.draft === undefined || receivedH.interpretation === undefined) {
        throw new Error(`H receive failed: ${JSON.stringify(receivedH.outcome)}`);
      }
      const published = await interpret(session.handler, {
        operation: "propose", source_handle: prepared.source_handle, draft: receivedH.draft,
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4",
        budget: BUDGET, authorized_scopes: SCOPES
      }, session.context);
      if (published.operation !== "propose" || published.published === undefined) {
        throw new Error(`propose failed: ${JSON.stringify(published.outcome)}`);
      }
      hId = published.published.interpretation_id;
      h = published.published.interpretation;
    } finally {
      await closeSession(session, filename);
    }

    const reopened = await openSession(filename);
    try {
      const admitted = receiveFrozenMeaningQ();
      expect(admitted.request.contract).toBe("source-semantic-query-request-v3");
      const qAfter = admitted.query;
      const alignment = receiveLatheA(qAfter, h, hId);
      const recalled = await interpret(reopened.handler, {
        operation: "recall", accepts_unreviewed_conditional_results: true, original_query: ORIGINAL,
        q: qAfter, alignments: [alignment], budget: BUDGET, output_byte_limit: 1_000_000, authorized_scopes: SCOPES
      }, reopened.context);
      if (recalled.operation !== "recall") throw new Error(`recall expected: ${JSON.stringify(recalled)}`);
      expect(recalled.provider_attempts).toBe(0);
      const proofSlot = recalled.slot_qualifiers?.find((row) => row.evidence_kind === "semantic_proof" && row.h_id === hId);
      expect(proofSlot).toBeDefined();
      expect(recalled.proofs?.some((row) => row.h_id === hId && (row.answers?.length ?? 0) > 0)).toBe(true);
      expect(recalled.results?.[proofSlot!.index]?.object_kind).toBe("semantic_proof");
      expect(recalled.delivery_id).toEqual(expect.any(String));
    } finally {
      await closeSession(reopened, filename);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
