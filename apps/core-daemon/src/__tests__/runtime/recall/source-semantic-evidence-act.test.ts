import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type SourceSemanticInterpretation, type SourceSemanticQuery,
  encodeSourceSemanticQueryCarrier, expandSourceSemanticQueryCarrier } from "@do-soul/alaya-protocol";
import {
  admitSourceSemanticQuery, createAuditedSourceAdmission, createSourceSemanticInterpretationPublication,
  EvidenceService, fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID,
  SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID
} from "@do-soul/alaya-core";
import {
  buildSourceSemanticRequest, receiveSourceSemantics, proposeQuerySemantics, sourceSemanticRequestCatalog
} from "@do-soul/alaya-soul";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import {
  createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { sourceSemanticQueryExamples } from "../../../../../../packages/soul/src/garden/ingestion/official-api/source-semantic-query-examples.js";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

const CLOCK = "2026-09-23T00:00:00.000Z";
const BUDGET = { schema_version: 1 as const, work_units: 200_000, memory_bytes: 20_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
const CASES = [
  { act: "question", text: "Was the lens polished?", predicate: "polished", example: sourceSemanticQueryExamples[5]! },
  { act: "directive", text: "Polish the lens.", predicate: "Polish", example: sourceSemanticQueryExamples[6]! }
] as const;

function withExplicitObligation(response: (typeof CASES)[number]["example"]["response"], obligation: "asserted_at_source" | "entailed_at_source") {
  const token = response.query.alternatives[0]!.conditions[0]!;
  if (!response.query.nodes.some(row => row.node === token)) throw new Error("evidence act fixture node missing");
  return { ...response, query: { ...response.query,
    nodes: response.query.nodes.map(row => row.node === token ? { ...row, obligation } : row) } };
}

function proposed(original: string, response: unknown) {
  const received = proposeQuerySemantics({ original_query: original,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1"
  }, { rawJson: JSON.stringify(response) });
  expect(received.outcome.status).toBe("interpreted");
  if (received.query === undefined) throw new Error("query proposal required");
  expect(received.query.gaps).toMatchObject([{ kind: "unsupported_meaning", affected_ids: ["polish"] }]);
  expect(admitSourceSemanticQuery(received.query, original).kind).toBe("admitted");
  return received.query;
}

function correspond(original: string, query: SourceSemanticQuery, source: SourceSemanticInterpretation, sourceId: string) {
  const frame = source.frames[0]!, queryFrame = query.alternatives[0]!.frames[0]!;
  const role = queryFrame.role_requirements[0]!, slot = frame.slots[0]!, referent = source.referents[0]!;
  if (frame.predicate_support.kind !== "explicit") throw new Error("explicit authored predicate required");
  const received = receiveAuthoredCorrespondence({ original_query: original, admitted_query_semantics: query,
    source_interpretation_descriptors: [{ source_interpretation_id: sourceId, interpretation: source }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1"
  }, { correspondences: [
    { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame.id },
      source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "polish" },
      source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }] },
    { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: queryFrame.id, slot: role.id },
      source_endpoint: { kind: "slot", frame: frame.id, slot: slot.id },
      query_support: role.support, source_semantic_support: slot.support },
    { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: role.target_variable },
      source_endpoint: { kind: "referent", referent: referent.id }, query_support: role.support,
      source_semantic_support: [{ kind: "lexical", mentions: referent.mentions }] }
  ] });
  expect(received.outcome).toEqual({ status: "interpreted", gaps: [] });
  if (received.semantic_correspondence === undefined) throw new Error("correspondence required");
  return received.semantic_correspondence;
}

it.each(CASES)("retrieves the shipped $act example after source receive, publication and SQLite reopen without proving actuality", async ({ act, text, predicate, example }) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("provider forbidden"); });
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-evidence-act-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const sourceId = `evidence-${act}`;
    const input = { sourceCorpus: text, assertionIds: [1], sourceScope: "complete-source" as const,
      source_id: sourceId, source_version: "1", producer_id: "authored-act", producer_version: "1" };
    const request = buildSourceSemanticRequest(input);
    const select = (text: string) => ({ assertion_id: 1, text });
    const received = receiveSourceSemantics(JSON.stringify({ contract: "source-semantic-proposal-v8",
      outcome: { status: "interpreted" }, content: {
        roots: [{ act, expression: { kind: "content_ref", key: "polish" } }],
        entities: [{ form: "selection", key: "lens", selection: select("the lens") }],
        nodes: [{ kind: "statement", key: "polish",
          predicate: { kind: "explicit", reading: "polish", support: select(predicate) },
          arguments: [{ role: "theme", target: { kind: "entity_ref", key: "lens" } }], qualifications: [] }], gaps: []
      }
    }), request, input);
    expect(received.outcome).toEqual({ status: "interpreted", gaps: [] });
    if (received.draft === undefined) throw new Error("source draft required");
    const eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
    const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
    await createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 }).admit({
      workspace_id: WS, source_id: sourceId, source_version: "1", content_bytes: text,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(text)
    }, { workspaceId: WS });
    const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
    const published = await createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 }).publish({
      workspaceId: WS, runId: RUN, artifactKey: sourceId, source: text,
      attribution_context: request.source_request.attribution_context!, catalog: sourceSemanticRequestCatalog(request),
      assertion_locations: request.source_request.assertion_locations!,
      provenance: { producer_id: input.producer_id }, producer_version: "1", contract_version: "source-interpretation-v4",
      draft: received.draft
    });
    expect(published.bound.interpretation.asserted_at_scope).toEqual([]);
    expect(published.bound.interpretation.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: act });
    database.close(); closeCachedDatabase(filename);
    const reopened = await createRecallRealStorage(() => undefined, filename);
    try {
      const execute = (original: string, response: unknown) => {
        const query = proposed(original, response);
        const result = runSourceSemanticWorker({ database: reopened.database } as RecallReadWorkerRuntime, {
          workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
          request: { kind: "reason", accepts_unreviewed_conditional_results: true, original_query: original, query_semantics: query,
            semantic_correspondence: correspond(original, query, published.bound.interpretation, published.bound.interpretation_id),
            source_interpretation_id: published.bound.interpretation_id, budget: BUDGET, output_byte_limit: 1_000_000 }
        });
        if (result.kind !== "reason") throw new Error("reason result required");
        expect(result.result.outcome.status).toBe("interpreted");
        expect(result.result.world_claim).toBe("unknown");
        expect(result.interpretation?.asserted_at_scope).toEqual([]);
        return { result: result.result, query };
      };
      // Use the shipped response unchanged: the host, not a fixture workaround, owns the default.
      const positive = execute(example.original_query, example.response);
      expect(positive.query.alternatives[0]!.context_obligations).toEqual([{ frame: "polish", kind: "unresolved" }]);
      expect(positive.result.binding_results).toHaveLength(1);
      expect(positive.result.binding_results![0]).toMatchObject({ kind: "answer", query_complete: false,
        returned: { polish: { node_id: published.bound.interpretation.frames[0]!.id } } });
      expect(positive.result.binding_results![0]!.explanation_ids.length).toBeGreaterThan(0);
      const other = CASES.find(row => row.act !== act)!;
      expect(execute(other.example.original_query, other.example.response).result.binding_results).toEqual([]);
      for (const obligation of [undefined, "asserted_at_source", "entailed_at_source"] as const) {
        const meaning = expandSourceSemanticQueryCarrier(example.response.query);
        const first = meaning.alternatives[0]!.conditions[0]!;
        if (first.kind !== "statement") throw new Error("evidence act fixture must be a statement");
        const { required_evidence_act: _act, ...statement } = first;
        const actual = execute("Was the lens polished?", { ...example.response, query: encodeSourceSemanticQueryCarrier({ ...meaning,
          gaps: [{ kind: "unsupported_meaning", affected_ids: ["polish"],
            support: [{ kind: "query_text", excerpt: "Was the lens polished" }],
            description: "The past polishing qualification is not encoded by the retained predicate." }],
          alternatives: [{ conditions: [{ ...statement, ...(obligation === undefined ? {} : { obligation }) }] }]
        }) });
        expect(actual.query.alternatives[0]!.context_obligations).toEqual([
          { frame: "polish", kind: obligation ?? "asserted_at_source" }
        ]);
        expect(actual.result.binding_results).toEqual([]);
      }
    } finally { reopened.database.close(); closeCachedDatabase(filename); }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    if (database.connection.open) database.close();
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it.each(CASES)("rejects explicit assertion and entailment conflicts for $act at proposal and canonical admission", ({ example }) => {
  for (const obligation of ["asserted_at_source", "entailed_at_source"] as const) {
    const response = withExplicitObligation(example.response, obligation);
    const received = proposeQuerySemantics({ original_query: example.original_query,
      producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" }, { rawJson: JSON.stringify(response) });
    expect(received.outcome.status).toBe("invalid");
    expect(received.query).toBeUndefined();
    const canonical = proposed(example.original_query, example.response);
    expect(admitSourceSemanticQuery({ ...canonical, alternatives: [{ ...canonical.alternatives[0],
      context_obligations: [{ frame: "polish", kind: obligation }]
    }] }, example.original_query).kind).toBe("invalid");
  }
});
