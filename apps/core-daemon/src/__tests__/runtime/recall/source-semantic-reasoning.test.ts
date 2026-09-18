import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  buildSourceReferenceCatalog, hashLabeledIdentity, sourceReferenceResolver,
  type SourceReferenceCatalog, type SourceSemanticAlignment, type SourceSemanticQuery,
  type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticQuery, createAuditedSourceAdmission, createSourceSemanticInterpretationPublication,
  EvidenceService, fieldContractSha256, SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
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
    contract: "source-interpretation-v3" as const,
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
    contract: "source-semantic-query-v1",
    original_query_digest: digestOriginalQuery(ORIGINAL),
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID,
    producer_version: "1",
    contract_version: "source-semantic-query-v1",
    variables: [{ id: "tools", sort: "entity" }, { id: "fUse", sort: "proposition" }],
    alternatives: [{
      frames: [{
        id: "qUse", variable: "fUse", predicate_reading: "use",
        role_requirements: [{
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

function alignmentOf(hId: string, q: SourceSemanticQuery): SourceSemanticAlignment {
  const admitted = admitSourceSemanticQuery(q, ORIGINAL);
  if (admitted.kind !== "admitted") throw new Error("query must admit");
  return {
    contract: "source-semantic-alignment-v1",
    h_id: hId, q_id: admitted.query_id,
    producer_id: SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID,
    producer_version: "1", contract_version: "source-semantic-alignment-v1",
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
        query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot: "theme" },
        source_endpoint: { kind: "slot", frame: "fUse", slot: "theme" },
        query_support: { kind: "query_text", excerpt: "tools" },
        source_semantic_support: [{ kind: "lexical", mentions: ["mTools"] }]
      }
    ]
  };
}

async function withPublished(body: (input: {
  hId: string; execute: Execute; filename: string; client: RecallReadWorkerClient;
}) => Promise<void>, options: Readonly<{
  valid_from?: string; valid_to?: string; state?: "erased" | "superseded";
  scope?: "project" | "global_core";
}> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-reasoning-"));
  const filename = join(directory, "memory.sqlite");
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
    producer_version: "p1", contract_version: "source-interpretation-v3"
  });
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
      hId: published.bound.interpretation_id, execute: (input) => client.sourceSemanticsPort!.execute(input),
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

it("prepares, reasons, and reopens durable H through a real worker fork", async () => {
  await withPublished(async ({ hId, execute }) => {
    const q = queryOf();
    const preparedSource = await call(execute, { kind: "prepare_source", source_id: "artifact-1", budget: BUDGET });
    if (preparedSource.kind !== "prepare_source") throw new Error("expected source handle");
    const preparedQuery = await call(execute, {
      kind: "prepare_query", original_query: ORIGINAL, q, budget: BUDGET,
      source_handle: preparedSource.source_handle
    });
    if (preparedQuery.kind !== "prepare_query") throw new Error("expected query handle");
    expect(preparedQuery.candidates.some((row) => row.interpretation_id === hId)).toBe(true);
    const reasoned = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: preparedQuery.query_handle, a: alignmentOf(hId, q),
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (reasoned.kind !== "reason") throw new Error("expected reason");
    expect(reasoned.result.outcome.status).toBe("interpreted");
    expect(reasoned.result.semantic_status).toBe("unreviewed");
    expect(reasoned.result.world_claim).toBe("unknown");
    expect(reasoned.result.c_id).toBeTruthy();
    expect(reasoned.result.consumed_leaves.length).toBeGreaterThan(0);
    expect(reasoned.interpretation).toBeDefined();
    expect(reasoned.alignment).toBeDefined();
    expect(reasoned.work.native_work).toBeGreaterThan(0);
    expect(reasoned.work.rss_bytes).toBeGreaterThan(0);
    expect("continuation" in reasoned).toBe(false);
    const retry = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      query_handle: preparedQuery.query_handle, a: alignmentOf(hId, q),
      budget: BUDGET, output_byte_limit: 1000000
    });
    if (retry.kind !== "reason") throw new Error("expected retry");
    expect(retry.work.native_work).toBeGreaterThan(0);
    expect("continuation" in retry).toBe(false);
    const clipped = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      h_id: hId, q, a: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1024
    });
    if (clipped.kind !== "reason") throw new Error("expected clipped");
    expect(clipped.result.outcome.status).toBe("truncated");
    expect(clipped.result.consumed_leaves).toEqual([]);
    expect(clipped.interpretation).toBeUndefined();
    expect(clipped.alignment).toBeUndefined();
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
      kind: "prepare_query", original_query: ORIGINAL, q: queryOf(), budget: BUDGET,
      source_handle: prepared.source_handle
    })).rejects.toThrow(/expired/u);
    const q = queryOf();
    const oneshot = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      h_id: hId, q, a: alignmentOf(hId, q), original_query: ORIGINAL,
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
        kind: "prepare_query", original_query: ORIGINAL, q, budget: BUDGET,
        source_handle: live.source_handle
      })).rejects.toThrow();
      const durable = await call(next, {
        kind: "reason", accepts_unreviewed_conditional_results: true,
        h_id: hId, q, a: alignmentOf(hId, q), original_query: ORIGINAL,
        budget: BUDGET, output_byte_limit: 1000000
      });
      if (durable.kind !== "reason") throw new Error("expected durable H");
      expect(durable.result.outcome.status).toBe("interpreted");
      expect(durable.result.h_id).toBe(hId);
    } finally { await reopened.close(); }
  });
}, 30000);

it.each(["erased", "superseded"] as const)("refuses %s source state after reopening", async (state) => {
  await withPublished(async ({ hId, execute }) => {
    const q = queryOf();
    await expect(call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      h_id: hId, q, a: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    })).rejects.toThrow();
  }, { state });
});

it("does not let a cache hit bypass erasure in the worker snapshot", async () => {
  await withPublished(async ({ hId, execute, filename }) => {
    const q = queryOf();
    const first = await call(execute, {
      kind: "reason", accepts_unreviewed_conditional_results: true,
      h_id: hId, q, a: alignmentOf(hId, q), original_query: ORIGINAL,
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
      h_id: hId, q, a: alignmentOf(hId, q), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000
    })).rejects.toThrow();
  });
}, 30000);
