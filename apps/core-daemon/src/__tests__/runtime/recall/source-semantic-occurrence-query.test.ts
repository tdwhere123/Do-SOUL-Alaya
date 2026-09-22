import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  buildSourceReferenceCatalog, materializeSourceSemanticQueryMeaning, sourceReferenceResolver,
  type SourceSemanticDraft, type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticQuery, createAuditedSourceAdmission, createSourceSemanticInterpretationPublication,
  EvidenceService, fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import {
  createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

const CLOCK = "2026-09-23T00:00:00.000Z";
const ORIGINAL = "Did ringing precede flashing?";
const ASSERTION = "Ringing preceded flashing.";
const SOURCE = `User: ${ASSERTION}`;
const BUDGET = { schema_version: 1 as const, work_units: 200_000, memory_bytes: 20_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };

function occurrenceQuery(): SourceSemanticQuery {
  return materializeSourceSemanticQueryMeaning({
    contract: "source-semantic-query-meaning-v4", gaps: [], return: ["precedence"],
    alternatives: [{ conditions: [
      { kind: "statement", key: "ring", predicate: "ring", arguments: [] },
      { kind: "statement", key: "flash", predicate: "flash", arguments: [] },
      { kind: "statement", key: "precedence", predicate: "precede", arguments: [
        { role: "earlier", target: { kind: "reference", key: "ring" }, excerpt: "ringing" },
        { role: "later", target: { kind: "reference", key: "flash" }, excerpt: "flashing" }
      ] }
    ] }]
  }, { original_query: ORIGINAL, original_query_digest: `sha256:${fieldContractSha256(ORIGINAL)}`,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" });
}

function sourceDraft(catalog: ReturnType<typeof buildSourceReferenceCatalog>): SourceSemanticDraft {
  const references = sourceReferenceResolver(catalog, fieldContractSha256);
  const mention = (id: string, text: string) => ({ id, assertion_id: 1,
    source_ref: references.referenceForSpan(1, [ASSERTION.indexOf(text), ASSERTION.indexOf(text) + text.length]) });
  const frame = (id: string, reading: string, support: string): SourceSemanticDraft["frames"][number] => ({
    id, assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
    predicate_support: { kind: "explicit", reading, mentions: [support] }, additional_support: [], slots: [], bindings: []
  });
  return { contract: "source-interpretation-v4", referents: [], operators: [], gaps: [],
    mentions: [mention("mRing", "Ringing"), mention("mPrecede", "preceded"), mention("mFlash", "flashing")],
    frames: [frame("fRing", "ring", "mRing"), frame("fFlash", "flash", "mFlash"), {
      ...frame("fPrecede", "precede", "mPrecede"),
      slots: [
        { id: "earlier", role_reading: "earlier", support: [{ kind: "lexical", mentions: ["mRing"] }] },
        { id: "later", role_reading: "later", support: [{ kind: "lexical", mentions: ["mFlash"] }] }
      ],
      bindings: [
        { slot_id: "earlier", target: { kind: "node", id: "fRing" }, support: [] },
        { slot_id: "later", target: { kind: "node", id: "fFlash" }, support: [] }
      ]
    }] };
}

function correspondence(query: SourceSemanticQuery, interpretation: SourceSemanticInterpretation, id: string) {
  const received = receiveAuthoredCorrespondence({ original_query: ORIGINAL, admitted_query_semantics: query,
    source_interpretation_descriptors: [{ source_interpretation_id: id, interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1"
  }, { correspondences: [
    ...[
      ["ring", "fRing", "ringing", "mRing"], ["flash", "fFlash", "flashing", "mFlash"],
      ["precedence", "fPrecede", "precede", "mPrecede"]
    ].map(([frame, source, excerpt, mention]) => ({ relation: "contextual_equivalence",
      query_endpoint: { kind: "predicate", alternative: 0, frame }, source_endpoint: { kind: "frame", frame: source },
      query_support: { kind: "query_text", excerpt }, source_semantic_support: [{ kind: "lexical", mentions: [mention] }] })),
    ...query.alternatives[0]!.frames.find(frame => frame.id === "precedence")!.role_requirements.map(role => ({
      relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "precedence", slot: role.id },
      source_endpoint: { kind: "slot", frame: "fPrecede", slot: role.role_reading }, query_support: role.support,
      source_semantic_support: [{ kind: "lexical", mentions: [role.role_reading === "earlier" ? "mRing" : "mFlash"] }]
    }))
  ] });
  if (received.semantic_correspondence === undefined) throw new Error(JSON.stringify(received.outcome));
  return received.semantic_correspondence;
}

it("consumes proposition role references after source publication and SQLite reopen without changing their root scope", async () => {
  const query = occurrenceQuery();
  const admitted = admitSourceSemanticQuery(query, ORIGINAL);
  expect(admitted.kind).toBe("admitted");
  expect(query.variables).toEqual([
    { id: "ring", sort: "proposition" }, { id: "flash", sort: "proposition" }, { id: "precedence", sort: "proposition" }
  ]);
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "ring", kind: "asserted_at_source" }, { frame: "flash", kind: "asserted_at_source" },
    { frame: "precedence", kind: "asserted_at_source" }
  ]);
  expect(query.alternatives[0]!.frames[2]!.role_requirements.map(role => role.target_variable)).toEqual(["ring", "flash"]);
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-occurrence-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
    const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
    await createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 }).admit({
      workspace_id: WS, source_id: "ringing-sequence", source_version: "1", content_bytes: SOURCE,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE)
    }, { workspaceId: WS });
    const catalog = buildSourceReferenceCatalog(fieldContractSha256(ASSERTION), [{ assertion_id: 1, text: ASSERTION }], fieldContractSha256);
    const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
    const published = await createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 }).publish({
      workspaceId: WS, runId: RUN, artifactKey: "ringing-sequence", source: SOURCE, catalog,
      provenance: { producer_id: "occurrence-test-author" }, producer_version: "1", contract_version: "source-interpretation-v4",
      draft: sourceDraft(catalog)
    });
    const alignment = correspondence(query, published.bound.interpretation, published.bound.interpretation_id);
    database.close(); closeCachedDatabase(filename);
    const reopened = await createRecallRealStorage(() => undefined, filename);
    try {
      const result = runSourceSemanticWorker({ database: reopened.database } as RecallReadWorkerRuntime, {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
        request: { kind: "reason", accepts_unreviewed_conditional_results: true,
          original_query: ORIGINAL, query_semantics: query, semantic_correspondence: alignment,
          source_interpretation_id: published.bound.interpretation_id, budget: BUDGET, output_byte_limit: 1_000_000 }
      });
      if (result.kind !== "reason") throw new Error("reason result required");
      expect(result.result.outcome.status).toBe("interpreted");
      expect(result.result.binding_results).toHaveLength(1);
      expect(result.result.binding_results![0]).toMatchObject({ kind: "answer", query_complete: true,
        bindings: { ring: { node_id: "fRing" }, flash: { node_id: "fFlash" }, precedence: { node_id: "fPrecede" } },
        returned: { precedence: { node_id: "fPrecede" } } });
      expect(result.result.binding_results![0]!.explanation_ids.length).toBeGreaterThan(0);
      expect(result.query).toEqual(query);
      expect(result.result.source_target).toEqual(published.bound.source_target);
      expect(result.interpretation?.entry_roots).toEqual(published.bound.interpretation.entry_roots);
      expect(result.interpretation?.asserted_at_scope).toEqual(published.bound.interpretation.asserted_at_scope);
      expect(result.work.native_work).toBeGreaterThan(0);
      expect(result.result.world_claim).toBe("unknown");
    } finally { reopened.database.close(); closeCachedDatabase(filename); }
  } finally {
    if (database.connection.open) database.close();
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
