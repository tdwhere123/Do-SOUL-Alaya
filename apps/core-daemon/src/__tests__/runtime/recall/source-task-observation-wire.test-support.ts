import { expect } from "vitest";
import { SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT } from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, admitSourceSemanticCorrespondence, createSourceSemanticInterpretationPublication,
  EvidenceService, fieldContractSha256, SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { buildSourceSemanticRequest, receiveSourceSemantics, sourceSemanticRequestCatalog, proposeQuerySemantics, indexSourceSemanticUnits }
  from "@do-soul/alaya-soul";
import { SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createSourceSemanticPublication } from "../../../runtime/field/source-semantic-publication.js";
import { queryWire, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { CLOCK, WS, type IndexFixture } from "./source-semantic-index-acquisition.test-support.js";

export const taskQuery = "What tool did I use to repair the hinge last Thursday?";
export const askedReport = "I repaired the hinge with a silver wrench on September 3.";
export const otherReport = "I repaired the lamp with a blue wrench on September 17.";
export const taskBody = `${taskQuery} ${askedReport} ${otherReport}`;
export const recorded = "2026-09-08T00:00:00.000Z";
export const questionTime = { interpretation_clock: CLOCK, intervals: [{ start: "2026-09-17", end: "2026-09-17" }] };

/** Authored provider-shaped fixture, not evidence of natural model availability or fidelity. */
export async function publishWireTaskSource(fixture: IndexFixture, sourceId = "original-0", body = taskBody, temporalOperand = true) {
  const input = { sourceCorpus: body, assertionIds: indexSourceSemanticUnits(body).map(unit => unit.assertion_id), sourceScope: "complete-source" as const,
    source_id: sourceId, source_version: "1", producer_id: "official-api-source-semantic", producer_version: "1" };
  const request = buildSourceSemanticRequest(input);
  const select = (text: string, assertion_id: number) => ({ assertion_id, text });
  const events = [
    { key: "hingeRepair", theme: "hinge", tool: "silver wrench", date: "September 3", assertion: 2 },
    { key: "lampRepair", theme: "lamp", tool: "blue wrench", date: "September 17", assertion: 3 }
  ];
  const roles = temporalOperand ? ["theme", "tool", "date"] : ["theme", "tool"];
  const wire = { contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" }, content: {
    roots: events.map(event => ({ act: "assertion", expression: { kind: "content_ref", key: event.key } })),
    entities: events.flatMap(event => roles.map(role => ({ form: "selection", key: `${event.key}${role}`,
      selection: select(event[role as "theme" | "tool" | "date"], event.assertion) }))),
    nodes: events.map(event => ({ kind: "statement", key: event.key,
      predicate: { kind: "explicit", reading: "repair", support: select(`repaired the ${event.theme}`, event.assertion) },
      arguments: roles.map(role => ({ role, target: { kind: "entity_ref", key: `${event.key}${role}` } })),
      qualifications: [] })), gaps: []
  } };
  const received = receiveSourceSemantics(JSON.stringify(wire), request, input);
  expect(received.outcome.status).toBe("interpreted");
  // The copied question (and optional record suffix) deliberately remain located H gaps.
  expect(received.outcome).toMatchObject({ gaps: expect.arrayContaining([
    expect.objectContaining({ kind: "uninterpreted_clause", affected_ids: ["hostAssertion1"] })
  ]) });
  if (received.draft === undefined) throw new Error("provider-shaped H must lower through receive");
  const eventLogRepo = new SqliteEventLogRepo(fixture.database), runtimeNotifier = { notifyEntry: async () => undefined };
  const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(fixture.database), now: () => CLOCK });
  const stores = createSqliteFieldFormationStores({ database: fixture.database, repos: createDaemonFieldRepos({ database: fixture.database }) });
  const published = await createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 }).publish({
    workspaceId: WS, runId: "run-1", artifactKey: sourceId, source: body,
    attribution_context: request.source_request.attribution_context!, catalog: sourceSemanticRequestCatalog(request),
    assertion_locations: request.source_request.assertion_locations!, provenance: { producer_id: input.producer_id },
    producer_version: "1", contract_version: "source-interpretation-v4", draft: received.draft
  });
  const q = proposeQuerySemantics({ original_query: taskQuery, producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" },
    { rawJson: queryWire(JSON.stringify({ outcome: { status: "interpreted" }, query: {
      contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, entities: [
        { kind: "named", key: "hinge", excerpt: "the hinge" },
        { kind: "free", key: "tool", excerpt: "What tool", return: false }
      ], requested_operation: { reading: "Identify the reported repair tool", support: { kind: "query_text", excerpt: "What tool" } },
      alternatives: [{ conditions: [], evidence_inputs: [{ conditions: [{ kind: "statement", predicate: "repair",
        arguments: [{ role: "theme", target: { kind: "reference", key: "hinge" }, excerpt: "the hinge" },
          { role: "tool", target: { kind: "reference", key: "tool" }, excerpt: "What tool" }] }] }] }], gaps: []
    } })) });
  expect(q.outcome.status, JSON.stringify(q.outcome)).toBe("interpreted");
  if (q.query === undefined) throw new Error("provider-shaped Q must lower through receive");
  expect(admitSourceSemanticQuery(q.query, taskQuery).kind).toBe("admitted");
  const h = published.bound.interpretation, frame = q.query.alternatives[0]!.frames[0]!;
  expect(h.frames.map(row => row.id)).not.toContain("hingeRepair");
  expect(h.frames[0]!.slots.map(row => row.id)).toEqual(temporalOperand ? ["argument0", "argument1", "argument2"] : ["argument0", "argument1"]);
  // The fixture explicitly proposes both predicate/slot correspondences. Only the hinge's named
  // referent agrees with Q; advertising the lamp frame must not make it executable asked-event evidence.
  const pairs = h.frames.flatMap(source => [
    { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: frame.id },
      source_endpoint: { kind: "frame", frame: source.id }, query_support: { kind: "query_text", excerpt: "repair" }, source_semantic_support: [] },
    ...frame.role_requirements.map((role, i) => ({ relation: "contextual_equivalence",
      query_endpoint: { kind: "slot", alternative: 0, frame: frame.id, slot: role.id },
      source_endpoint: { kind: "slot", frame: source.id, slot: source.slots[i]!.id }, query_support: role.support, source_semantic_support: [] }))
  ]);
  const hinge = h.frames[0]!.bindings[0]!.target;
  if (hinge.kind !== "node") throw new Error("bound fixture hinge required");
  const c = receiveAuthoredCorrespondence({ original_query: taskQuery, admitted_query_semantics: q.query,
    source_interpretation_descriptors: [{ source_interpretation_id: published.bound.interpretation_id, interpretation: h }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, { correspondences: [...pairs,
    { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: frame.role_requirements[0]!.target_variable },
      source_endpoint: { kind: "referent", referent: hinge.id }, query_support: { kind: "query_text", excerpt: "the hinge" }, source_semantic_support: [] }
  ] });
  if (c.semantic_correspondence === undefined) throw new Error(JSON.stringify(c.outcome));
  expect(admitSourceSemanticCorrespondence({ original_query: taskQuery, query_semantics: q.query,
    source_interpretation: h, semantic_correspondence: c.semantic_correspondence }).kind).toBe("admitted");
  return { source: { source_ref: "source1", target: published.bound.source_target,
    body, source_observed_at: recorded, selected_interpretation: published.bound },
    selection: { query_semantics: q.query, semantic_correspondences: [c.semantic_correspondence] },
    withdraw: () => createSourceSemanticPublication({ database: fixture.database, evidenceService }).invalidate!({ request: {
      workspace_id: WS, run_id: "run-1", source_interpretation_id: published.bound.interpretation_id,
      source: { source_id: sourceId, source_version: "1", content_digest: published.bound.source_target.content_digest },
      error_basis: { reason: "Fixture interpretation withdrawn.", basis_ref: "source-review" }, provenance: { reporter_id: "local-reviewer" },
      authorized_scopes: { mode: "named", scopes: ["project"] } }, budget: { schema_version: 1, work_units: 2_000_000,
        memory_bytes: 32_000_000, page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 } }) };
}
