import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SoulInterpretationRequestSchema, sourceReferenceResolver,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceReferenceCatalog, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticQuery, createAuditedSourceAdmission,
  createSourceSemanticInterpretationPublication, EvidenceService, fieldContractSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import {
  closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo
} from "@do-soul/alaya-storage";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import {
  decodeEngineBindings, oracleBindingsMatchEngine, oracleNecessaryLeavesHeld, oracleProofsMatchEngine,
  oracleSourceSemanticJoin
} from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-relational-oracle.js";
import {
  createRecallRealStorage,
  REAL_SQLITE_TEST_RUN_ID as RUN,
  REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { builtWorkerUrl } from "../../runtime/recall/recall-read-worker-client-fixture.js";
import { createDeps } from "./mcp-memory-tool-handler-fixture.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const SOURCE = "User: Alice uses tools.";
const BUDGET = {
  schema_version: 1 as const,
  work_units: 200000,
  memory_bytes: 20000000,
  page_budget: 100000,
  finalization_reserve: 10000,
  min_envelope: 10
};

const ALICE_CORRESPONDENCES: import("@do-soul/alaya-protocol").SourceSemanticCorrespondence["correspondences"] = [
  { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
    source_endpoint: { kind: "referent", referent: "rAlice" }, query_support: { kind: "query_text", excerpt: "Alice" }, source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] },
  { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "agent" },
    source_endpoint: { kind: "slot", frame: "fUse", slot: "agent" }, query_support: { kind: "query_text", excerpt: "Alice" }, source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] }
];

it("runs prepare_source through the worker on MCP and the same handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "soul-interpretation-mcp-"));
  const filename = join(directory, "memory.sqlite");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({
    database,
    repos: createDaemonFieldRepos({ database })
  });
  const admission = createAuditedSourceAdmission({
    stores,
    eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined },
    sha256: fieldContractSha256
  });
  await admission.admit({
    workspace_id: WS,
    source_id: "artifact-1",
    source_version: "1",
    content_bytes: SOURCE,
    evidence_object_id: null,
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    speaker: "user",
    scope_class: "project",
    spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  database.close();
  closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({
    databaseFilename: filename,
    workerUrl: builtWorkerUrl,
    workerCount: 1
  })!;
  const context = {
    workspaceId: WS,
    runId: "run1",
    agentTarget: "codex",
    sessionId: "soul-interpretation-worker"
  };
  const handler = createMcpMemoryToolHandler({
    ...createDeps(),
    now: () => CLOCK,
    sourceSemanticsPort: client.sourceSemanticsPort
  });
  try {
    await client.ready();
    const args = { operation: "prepare_source", source_id: "artifact-1", budget: BUDGET };
    const direct = await callInterpretation(handler, { toolName: "soul.interpretation", arguments: args, context });
    const mcp = await callAlayaMcpMemoryTool(
      { memoryToolHandler: handler, contextProvider: () => context },
      "soul.interpretation",
      args
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error("prepare_source through worker must succeed");
    expect(direct.output).toMatchObject({
      operation: "prepare_source",
      source_id: "artifact-1",
      provider_attempts: 0
    });
    expect("source_handle" in direct.output).toBe(true);
    expect((mcp.structuredContent as { output: unknown }).output).toMatchObject({
      operation: "prepare_source",
      source_id: "artifact-1",
      provider_attempts: 0
    });
  } finally {
    await client.close();
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
});

const ORIGINAL = "which tools does Alice use?";

function usesDraft(catalog: SourceReferenceCatalog, text: string, extra: { themeBound?: boolean } = {}) {
  const references = sourceReferenceResolver(catalog, fieldContractSha256);
  const sourceRef = (word: string) => references.referenceForSpan(1, [
    text.indexOf(word), text.indexOf(word) + word.length
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
      bindings: extra.themeBound === false
        ? [{ slot_id: "agent", target: { kind: "node" as const, id: "rAlice" }, support: [] }]
        : [
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

const WHO = "who uses the tools?";

function agentQuery(): SourceSemanticQuery {
  return {
    contract: "source-semantic-query-v4",
    original_query_digest: digestOriginalQuery(WHO),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v4",
    variables: [{ id: "who", sort: "entity" }, { id: "fUse", sort: "proposition" }],
    alternatives: [{
      frames: [{
        id: "qUse", variable: "fUse", predicate_reading: "use",
        role_requirements: [{
          id: "agent", role_reading: "agent", target_variable: "who",
          support: { kind: "query_text", excerpt: "who" }
        }]
      }],
      context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }]
    }],
    return_variables: ["who"],
    gaps: []
  };
}

function themeCorrespondence(sourceInterpretationId: string, querySemanticsId: string) {
  return {
    contract: "source-semantic-correspondence-v3" as const,
    source_interpretation_id: sourceInterpretationId, query_semantics_id: querySemanticsId,
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
    producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [
      ...ALICE_CORRESPONDENCES,
      {
        relation: "contextual_equivalence" as const,
        query_endpoint: { kind: "predicate" as const, alternative: 0, frame: "qUse" },
        source_endpoint: { kind: "frame" as const, frame: "fUse" },
        query_support: { kind: "query_text" as const, excerpt: "use" },
        source_semantic_support: [{ kind: "lexical" as const, mentions: ["mUses"] }]
      },
      {
        relation: "contextual_equivalence" as const,
        query_endpoint: { kind: "slot" as const, alternative: 0, frame: "qUse", slot: "theme" },
        source_endpoint: { kind: "slot" as const, frame: "fUse", slot: "theme" },
        query_support: { kind: "query_text" as const, excerpt: "tools" },
        source_semantic_support: [{ kind: "lexical" as const, mentions: ["mTools"] }]
      }
    ]
  };
}

it("runs the offline native chain through MCP/handler after SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "soul-interpretation-native-"));
  const filename = join(directory, "memory.sqlite");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({
    database,
    repos: createDaemonFieldRepos({ database })
  });
  const admission = createAuditedSourceAdmission({
    stores,
    eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined },
    sha256: fieldContractSha256
  });
  await admission.admit({
    workspace_id: WS,
    source_id: "artifact-1",
    source_version: "1",
    content_bytes: SOURCE,
    evidence_object_id: null,
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    speaker: "user",
    scope_class: "project",
    spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  database.close();
  closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({
    databaseFilename: filename,
    workerUrl: builtWorkerUrl,
    workerCount: 1
  })!;
  const { database: publishDb } = await createRecallRealStorage(() => undefined, filename);
  const publishStores = createSqliteFieldFormationStores({
    database: publishDb,
    repos: createDaemonFieldRepos({ database: publishDb })
  });
  const evidenceService = new EvidenceService({
    eventLogRepo: new SqliteEventLogRepo(publishDb),
    runtimeNotifier: { notifyEntry: async () => undefined },
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(publishDb),
    now: () => CLOCK
  });
  const publication = createSourceSemanticInterpretationPublication({
    stores: publishStores, evidenceService, sha256: fieldContractSha256
  });
  const context = {
    workspaceId: WS,
    runId: RUN,
    agentTarget: "codex",
    sessionId: "soul-interpretation-native"
  };
  const handler = createMcpMemoryToolHandler({
    ...createDeps(),
    now: () => CLOCK,
    sourceSemanticsPort: client.sourceSemanticsPort,
    sourceSemanticPublication: {
      publish: (input) => publication.publish(input)
    }
  });
  try {
    await client.ready();
    const prepareArgs = SoulInterpretationRequestSchema.parse({
      operation: "prepare_source", source_id: "artifact-1", budget: BUDGET
    });
    const prepared = await callInterpretation(handler, { toolName: "soul.interpretation", arguments: prepareArgs, context });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("prepare_source must succeed");
    expect(prepared.output.provider_attempts).toBe(0);
    if (prepared.output.operation !== "prepare_source" || prepared.output.source_handle === undefined ||
        prepared.output.catalog === undefined) {
      throw new Error("prepare_source must return a handle and catalog");
    }
    const proposeArgs = SoulInterpretationRequestSchema.parse({
      operation: "propose",
      source_handle: prepared.output.source_handle,
      draft: usesDraft(prepared.output.catalog, SOURCE),
      producer_id: "test-author",
      producer_version: "p1",
      contract_version: "source-interpretation-v4"
    });
    const proposed = await callInterpretation(handler, { toolName: "soul.interpretation", arguments: proposeArgs, context });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) throw new Error("propose must succeed");
    expect(proposed.output.provider_attempts).toBe(0);
    if (proposed.output.operation !== "propose" || proposed.output.published === undefined) {
      throw new Error("propose must publish the source interpretation");
    }
    const sourceInterpretationId = proposed.output.published.interpretation_id;
    expect(publishDb.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    expect(publishDb.connection.prepare("SELECT count(*) AS n FROM relation_assertions").get()).toEqual({ n: 0 });
    publishDb.close();
    closeCachedDatabase(filename);
    await client.close();
    closeCachedDatabase(filename);
    const reopened = createRecallReadWorkerClient({
      databaseFilename: filename,
      workerUrl: builtWorkerUrl,
      workerCount: 1
    })!;
    const freshHandler = createMcpMemoryToolHandler({
      ...createDeps(),
      now: () => CLOCK,
      sourceSemanticsPort: reopened.sourceSemanticsPort
    });
    try {
      await reopened.ready();
      const querySemantics = queryOf();
      const prepareQueryArgs = SoulInterpretationRequestSchema.parse({
        operation: "prepare_query", original_query: ORIGINAL, query_semantics: querySemantics, budget: BUDGET
      });
      const preparedQuery = await callInterpretation(freshHandler, {
        toolName: "soul.interpretation", arguments: prepareQueryArgs, context
      });
      expect(preparedQuery.ok).toBe(true);
      if (!preparedQuery.ok) throw new Error("prepare_query must succeed");
      expect(preparedQuery.output.provider_attempts).toBe(0);
      if (preparedQuery.output.operation !== "prepare_query" || preparedQuery.output.query_handle === undefined) {
        throw new Error("prepare_query must return a handle");
      }
      expect(preparedQuery.output.candidates.some((row) => row.interpretation_id === sourceInterpretationId)).toBe(true);
      const admitted = admitSourceSemanticQuery(querySemantics, ORIGINAL);
      if (admitted.kind !== "admitted") throw new Error("query must admit");
      const semanticCorrespondence = {
        contract: "source-semantic-correspondence-v3" as const,
        source_interpretation_id: sourceInterpretationId, query_semantics_id: admitted.query_id,
        producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
        producer_version: "1", contract_version: "source-semantic-correspondence-v3",
        correspondences: [
      ...ALICE_CORRESPONDENCES,
          {
            relation: "contextual_equivalence" as const,
            query_endpoint: { kind: "predicate" as const, alternative: 0, frame: "qUse" },
            source_endpoint: { kind: "frame" as const, frame: "fUse" },
            query_support: { kind: "query_text" as const, excerpt: "use" },
            source_semantic_support: [{ kind: "lexical" as const, mentions: ["mUses"] }]
          },
          {
            relation: "contextual_equivalence" as const,
            query_endpoint: { kind: "slot" as const, alternative: 0, frame: "qUse", slot: "theme" },
            source_endpoint: { kind: "slot" as const, frame: "fUse", slot: "theme" },
            query_support: { kind: "query_text" as const, excerpt: "tools" },
            source_semantic_support: [{ kind: "lexical" as const, mentions: ["mTools"] }]
          }
        ]
      };
      const reasonArgs = SoulInterpretationRequestSchema.parse({
        operation: "reason",
        accepts_unreviewed_conditional_results: true,
        query_handle: preparedQuery.output.query_handle,
        semantic_correspondence: semanticCorrespondence, budget: BUDGET, output_byte_limit: 1000000
      });
      const direct = await callInterpretation(freshHandler, {
        toolName: "soul.interpretation", arguments: reasonArgs, context
      });
      const mcp = await callAlayaMcpMemoryTool(
        { memoryToolHandler: freshHandler, contextProvider: () => context },
        "soul.interpretation",
        reasonArgs
      );
      expect(direct.ok).toBe(true);
      if (!direct.ok) throw new Error("reason must succeed");
      expect(direct.output.provider_attempts).toBe(0);
      const mcpOutput = (mcp.structuredContent as { output: typeof direct.output }).output;
      expect(mcpOutput.operation).toBe(direct.output.operation);
      expect(mcpOutput.provider_attempts).toBe(0);
      if (direct.output.operation !== "reason" || mcpOutput.operation !== "reason") {
        throw new Error("reason must return a result");
      }
      expect(mcpOutput.result).toEqual(direct.output.result);
      expect(mcpOutput.coverage).toEqual(direct.output.coverage);
      if (direct.output.result === undefined) {
        throw new Error("reason must return a result");
      }
      expect(direct.output.result.outcome.status).toBe("interpreted");
      expect(direct.output.result.world_claim).toBe("unknown");
      expect(direct.output.result.semantic_status).toBe("unreviewed");
      expect(direct.output.result.source_interpretation_id).toBe(sourceInterpretationId);
      expect(direct.output.coverage.conditional_computation).toBe("complete");
      expect(direct.output.coverage.discovery).not.toBe("unexercised");
      const interpretation = direct.output.interpretation;
      const semantic_correspondence = direct.output.semantic_correspondence;
      expect(semantic_correspondence).toBeDefined();
      if (semantic_correspondence === undefined) throw new Error("reason must return semantic correspondence");
      expect(interpretation).toBeDefined();
      if (interpretation === undefined) throw new Error("reason must return the source interpretation");
      const oracle = oracleSourceSemanticJoin(interpretation, querySemantics, semantic_correspondence);
      const decoded = decodeEngineBindings(direct.output.result);
      expect(oracleBindingsMatchEngine(oracle, decoded, ["tools", "fUse"])).toBe(true);
      expect(oracleNecessaryLeavesHeld(oracle, direct.output.result.consumed_leaves)).toBe(true);
      expect(oracleProofsMatchEngine(oracle, direct.output.result)).toBe(true);
      expect(decoded).toEqual([{ actor: "rAlice", tools: "rTools", fUse: "fUse" }]);
      const { database: inspectedDb } = await createRecallRealStorage(() => undefined, filename);
      try {
        expect(inspectedDb.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
        expect(inspectedDb.connection.prepare("SELECT count(*) AS n FROM relation_assertions").get()).toEqual({ n: 0 });
      } finally {
        inspectedDb.close();
      }
    } finally {
      await reopened.close();
    }
  } finally {
    try { publishDb.close(); } catch { /* already closed */ }
    try { await client.close(); } catch { /* already closed */ }
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("retains public propose generation_task through SQLite reopen and lightweight disclosure", async () => {
  const generation_task = {
    contract: "source-semantic-generation-task-v1" as const, context: "complete_original_source" as const,
    original_query: ORIGINAL, responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const }
  };
  const directory = await mkdtemp(join(tmpdir(), "soul-interpretation-task-"));
  const filename = join(directory, "memory.sqlite");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  await createAuditedSourceAdmission({
    stores, eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  }).admit({
    workspace_id: WS, source_id: "artifact-1", source_version: "1", content_bytes: SOURCE, evidence_object_id: null,
    recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
    spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  database.close();
  closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  const { database: publishDb } = await createRecallRealStorage(() => undefined, filename);
  const publication = createSourceSemanticInterpretationPublication({
    stores: createSqliteFieldFormationStores({ database: publishDb, repos: createDaemonFieldRepos({ database: publishDb }) }),
    evidenceService: new EvidenceService({
      eventLogRepo: new SqliteEventLogRepo(publishDb), runtimeNotifier: { notifyEntry: async () => undefined },
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(publishDb), now: () => CLOCK
    }), sha256: fieldContractSha256
  });
  const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "soul-interpretation-task" };
  const handler = createMcpMemoryToolHandler({
    ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort,
    sourceSemanticPublication: { publish: (input) => publication.publish(input) }
  });
  try {
    await client.ready();
    const prepared = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({ operation: "prepare_source", source_id: "artifact-1", budget: BUDGET }),
      context
    });
    if (!prepared.ok || prepared.output.operation !== "prepare_source" || prepared.output.source_handle === undefined
      || prepared.output.catalog === undefined) throw new Error("prepare_source must return a handle and catalog");
    const proposed = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "propose", source_handle: prepared.output.source_handle,
        draft: usesDraft(prepared.output.catalog, SOURCE), generation_task,
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4"
      }),
      context
    });
    if (!proposed.ok || proposed.output.operation !== "propose" || proposed.output.published === undefined) {
      throw new Error("propose must publish the source interpretation");
    }
    expect(proposed.output.published.interpretation.generation_task).toEqual(generation_task);
    const sourceInterpretationId = proposed.output.published.interpretation_id;
    publishDb.close();
    closeCachedDatabase(filename);
    await client.close();
    closeCachedDatabase(filename);
    const reopened = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
    const freshHandler = createMcpMemoryToolHandler({
      ...createDeps(), now: () => CLOCK, sourceSemanticsPort: reopened.sourceSemanticsPort
    });
    try {
      await reopened.ready();
      const preparedQuery = await callInterpretation(freshHandler, {
        toolName: "soul.interpretation",
        arguments: SoulInterpretationRequestSchema.parse({
          operation: "prepare_query", original_query: ORIGINAL, query_semantics: queryOf(), budget: BUDGET
        }),
        context
      });
      if (!preparedQuery.ok || preparedQuery.output.operation !== "prepare_query") throw new Error("prepare_query must succeed");
      const descriptor = preparedQuery.output.candidates.find((row) => row.interpretation_id === sourceInterpretationId);
      expect(descriptor?.generation_task).toEqual({
        contract: "source-semantic-generation-task-v1", context: "complete_original_source",
        responsibility: { kind: "original_query_task", other_meaning: "unassessed" }
      });
      expect(descriptor?.generation_task).not.toHaveProperty("original_query");
      const { database: inspectedDb } = await createRecallRealStorage(() => undefined, filename);
      try {
        const stored = inspectedDb.connection.prepare("SELECT gist FROM evidence_capsules").get() as { gist: string } | undefined;
        expect(JSON.parse(stored!.gist).interpretation.generation_task).toEqual(generation_task);
      } finally { inspectedDb.close(); }
    } finally { await reopened.close(); }
  } finally {
    try { publishDb.close(); } catch { /* already closed */ }
    try { await client.close(); } catch { /* already closed */ }
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("publishes a legal ablated source interpretation, rebinds semantic correspondence, and keeps the unbound-theme-independent agent proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "soul-interpretation-ablate-"));
  const filename = join(directory, "memory.sqlite");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({
    database, repos: createDaemonFieldRepos({ database })
  });
  const admission = createAuditedSourceAdmission({
    stores, eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  });
  await admission.admit({
    workspace_id: WS, source_id: "artifact-1", source_version: "1", content_bytes: SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE)
  }, { workspaceId: WS });
  database.close();
  closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({
    databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
  })!;
  const { database: publishDb } = await createRecallRealStorage(() => undefined, filename);
  const publishStores = createSqliteFieldFormationStores({
    database: publishDb, repos: createDaemonFieldRepos({ database: publishDb })
  });
  const publication = createSourceSemanticInterpretationPublication({
    stores: publishStores,
    evidenceService: new EvidenceService({
      eventLogRepo: new SqliteEventLogRepo(publishDb),
      runtimeNotifier: { notifyEntry: async () => undefined },
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(publishDb), now: () => CLOCK
    }),
    sha256: fieldContractSha256
  });
  const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "soul-interpretation-ablate" };
  const handler = createMcpMemoryToolHandler({
    ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort,
    sourceSemanticPublication: {
      publish: (input) => publication.publish(input)
    }
  });
  try {
    await client.ready();
    const prepared = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "prepare_source", source_id: "artifact-1", budget: BUDGET
      }),
      context
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.output.operation !== "prepare_source" ||
        prepared.output.source_handle === undefined || prepared.output.catalog === undefined) {
      throw new Error("prepare_source must return a handle and catalog");
    }
    const catalog = prepared.output.catalog;
    const handle = prepared.output.source_handle;
    const first = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "propose", source_handle: handle, draft: usesDraft(catalog, SOURCE),
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4"
      }),
      context
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.output.operation !== "propose" || first.output.published === undefined) {
      throw new Error("first propose must publish the source interpretation");
    }
    const firstInterpretationId = first.output.published.interpretation_id;
    expect(first.output.published.interpretation.frames[0]?.slots.some((row) => row.id === "theme")).toBe(true);
    const querySemantics = queryOf();
    const admitted = admitSourceSemanticQuery(querySemantics, ORIGINAL);
    if (admitted.kind !== "admitted") throw new Error("theme query must admit");
    const before = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: firstInterpretationId, query_semantics: querySemantics, semantic_correspondence: themeCorrespondence(firstInterpretationId, admitted.query_id), original_query: ORIGINAL,
        budget: BUDGET, output_byte_limit: 1000000
      }),
      context
    });
    expect(before.ok).toBe(true);
    if (!before.ok || before.output.operation !== "reason" || before.output.result === undefined) {
      throw new Error("reason on the published source interpretation must succeed");
    }
    expect(before.output.result.outcome.status).toBe("interpreted");
    expect(before.output.result.consumed_leaves.some((row) => row.leaf_kind === "source_interpretation_binding" && row.slot_id === "theme")).toBe(true);
    const ablated = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "propose", source_handle: handle,
        draft: usesDraft(catalog, SOURCE, { themeBound: false }),
        producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4"
      }),
      context
    });
    expect(ablated.ok).toBe(true);
    if (!ablated.ok || ablated.output.operation !== "propose" || ablated.output.published === undefined) {
      throw new Error("ablated propose must publish a new source interpretation");
    }
    const secondInterpretationId = ablated.output.published.interpretation_id;
    expect(secondInterpretationId).not.toBe(firstInterpretationId);
    expect(ablated.output.published.interpretation.frames[0]?.slots.some((row) => row.id === "theme")).toBe(true);
    expect(ablated.output.published.interpretation.frames[0]?.bindings.some((row) => row.slot_id === "theme")).toBe(false);
    const stale = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: secondInterpretationId, query_semantics: querySemantics, semantic_correspondence: themeCorrespondence(firstInterpretationId, admitted.query_id), original_query: ORIGINAL,
        budget: BUDGET, output_byte_limit: 1000000
      }),
      context
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok || stale.output.operation !== "reason" || stale.output.result === undefined) {
      throw new Error("stale semantic correspondence must return a reason result");
    }
    expect(stale.output.result.outcome).toEqual({ status: "invalid", reason: "malformed_correspondence" });
    const rebound = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: secondInterpretationId, query_semantics: querySemantics, semantic_correspondence: themeCorrespondence(secondInterpretationId, admitted.query_id), original_query: ORIGINAL,
        budget: BUDGET, output_byte_limit: 1000000
      }),
      context
    });
    expect(rebound.ok).toBe(true);
    if (!rebound.ok || rebound.output.operation !== "reason" || rebound.output.result === undefined) {
      throw new Error("rebound theme reason must return a result");
    }
    expect(rebound.output.result.consumed_leaves).toEqual([]);
    const who = agentQuery();
    const admittedWho = admitSourceSemanticQuery(who, WHO);
    if (admittedWho.kind !== "admitted") throw new Error("agent query must admit");
    const remaining = await callInterpretation(handler, {
      toolName: "soul.interpretation",
      arguments: SoulInterpretationRequestSchema.parse({
        operation: "reason", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: secondInterpretationId, query_semantics: who,
        semantic_correspondence: {
          contract: "source-semantic-correspondence-v3",
          source_interpretation_id: secondInterpretationId, query_semantics_id: admittedWho.query_id,
          producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
          producer_version: "1", contract_version: "source-semantic-correspondence-v3",
          correspondences: [
            {
              relation: "contextual_equivalence",
              query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
              source_endpoint: { kind: "frame", frame: "fUse" },
              query_support: { kind: "query_text", excerpt: "use" },
              source_semantic_support: [{ kind: "lexical", mentions: ["mUses"] }]
            },
            {
              relation: "contextual_equivalence",
              query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "agent" },
              source_endpoint: { kind: "slot", frame: "fUse", slot: "agent" },
              query_support: { kind: "query_text", excerpt: "who" },
              source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }]
            }
          ]
        },
        original_query: WHO, budget: BUDGET, output_byte_limit: 1000000
      }),
      context
    });
    expect(remaining.ok).toBe(true);
    if (!remaining.ok || remaining.output.operation !== "reason" || remaining.output.result === undefined) {
      throw new Error("agent proof on the ablated source interpretation must succeed");
    }
    expect(remaining.output.result.outcome.status).toBe("interpreted");
    expect(remaining.output.result.consumed_leaves.some((row) => row.leaf_kind === "source_interpretation_binding" && row.slot_id === "agent")).toBe(true);
    expect(remaining.output.result.source_interpretation_id).toBe(secondInterpretationId);
    expect(remaining.output.provider_attempts).toBe(0);
  } finally {
    try { publishDb.close(); } catch { /* closed */ }
    try { await client.close(); } catch { /* closed */ }
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

async function callInterpretation(handler: ReturnType<typeof createMcpMemoryToolHandler>,
  input: Parameters<ReturnType<typeof createMcpMemoryToolHandler>["call"]>[0]) {
  const result = await handler.call(input);
  if (result.ok && result.tool_name !== "soul.interpretation") throw new Error("handler dispatched a different tool");
  return result;
}
