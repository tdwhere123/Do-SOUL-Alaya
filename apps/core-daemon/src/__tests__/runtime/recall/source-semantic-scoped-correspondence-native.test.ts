import { afterAll, expect, it, vi } from "vitest";

// Mechanism test: authored outputs only. Install guards before application imports.
const isolation = await vi.hoisted(async () => {
  const [{ default: http }, { default: https }, { default: net }, { default: tls },
    { default: http2 }, { default: dgram }, { default: fs }, { default: fsp }, { syncBuiltinESMExports }] =
    await Promise.all([import("node:http"), import("node:https"), import("node:net"), import("node:tls"),
      import("node:http2"), import("node:dgram"), import("node:fs"), import("node:fs/promises"), import("node:module")]);
  const restores: (() => void)[] = [];
  const forbidden: string[] = [];
  function block(owner: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    Object.defineProperty(owner, key, { ...descriptor, value: () => {
      forbidden.push(key);
      throw new Error(`Network access forbidden in authored mechanism test: ${key}`);
    } });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  for (const owner of [http, https]) for (const key of ["request", "get"]) block(owner, key);
  for (const key of ["connect", "createConnection"]) block(net, key);
  block(net.Socket.prototype, "connect"); block(tls, "connect"); block(http2, "connect");
  block(dgram, "createSocket"); block(globalThis, "fetch");
  const environment = process.env;
  process.env = new Proxy(environment, { get(target, key) {
    if (typeof key === "string" && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)) {
      forbidden.push("credential environment read");
      throw new Error("Credential environment reads forbidden in authored mechanism test");
    }
    return Reflect.get(target, key);
  } });
  restores.push(() => { process.env = environment; });
  for (const owner of [fs, fsp]) {
    for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor?.value === undefined) continue;
      Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          if (/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(String(args[0]))) {
            forbidden.push("credential file read");
            throw new Error("Credential file reads forbidden in authored mechanism test");
          }
          return Reflect.apply(target, receiver, args);
        }
      }) });
      restores.push(() => Object.defineProperty(owner, key, descriptor));
    }
  }
  syncBuiltinESMExports();
  return { forbidden, restore: () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  sourceSemanticCorrespondenceGenerationPolicies, sourceSemanticCorrespondenceIdentity,
  type SourceSemanticInterpretation, type SourceSemanticLibraryProof, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import {
  createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, deliveredSourceSemanticLibraryProof, EvidenceService,
  fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { buildSourceSemanticCorrespondenceRequest, proposeCorrespondenceSemantics, proposeSourceSemantics } from "@do-soul/alaya-soul";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import {
  createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { builtWorkerUrl, assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { authoredQuerySemantics } from "./source-semantic-producer-fixture.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";

afterAll(() => isolation.restore());

const CLOCK = "2026-09-21T10:00:00.000Z";
const SOURCE = "Alice uses tools and Bob repairs lathes.";
const SOURCE_ID = "artifact-workshop";
const ORIGINAL = "Give five examples of who used tools or repaired lathes.";
const BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };
const SCOPES = { mode: "named" as const, scopes: ["project"] };
const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: "scoped-correspondence-native" };
const BRANCHES = [
  { frame: "qUse", proposition: "useEvent", predicate: "use", query: "used", verb: "uses", person: "Alice", thing: "tools" },
  { frame: "qRepair", proposition: "repairEvent", predicate: "repair", query: "repaired", verb: "repairs", person: "Bob", thing: "lathes" }
] as const;
const QUERY_GAPS = [
  { kind: "aggregate", affected_ids: [], support: [{ kind: "query_text", excerpt: "five examples" }],
    description: "The requested five-example operation remains unexecuted." },
  { kind: "unsupported_meaning", affected_ids: ["qUse", "qRepair"],
    support: [{ kind: "query_text", excerpt: "used tools or repaired lathes" }],
    description: "The original past tense is not encoded by these predicates." }
] as const;

function authoredQuery(original = ORIGINAL): SourceSemanticQuery {
  return authoredQuerySemantics({ original_query: original,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
    variables: [{ id: "person", sort: "entity" }, { id: "thing", sort: "entity" },
      ...BRANCHES.map(row => ({ id: row.proposition, sort: "proposition" }))],
    alternatives: [{ frames: BRANCHES.map(row => ({ id: row.frame, variable: row.proposition,
      predicate_reading: row.predicate, role_requirements: [
        { id: "agent", role_reading: "agent", target_variable: "person", support: { kind: "query_text", excerpt: "who" } },
        { id: "theme", role_reading: "theme", target_variable: "thing", support: { kind: "query_text", excerpt: row.thing } }
      ] })), context_obligations: BRANCHES.map(row => ({ frame: row.frame, kind: "asserted_at_source" })),
      answer_frames: [], evidence_inputs: BRANCHES.map(row => ({ frames: [row.frame] })) }],
    return_variables: ["person", "thing"], gaps: QUERY_GAPS,
    requested_operation: { reading: "give five examples", support: { kind: "query_text", excerpt: "Give five examples" } }
  }).query;
}

async function openNativeSession(filename: string) {
  assertBuiltWorker();
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
  const evidenceService = new EvidenceService({ eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: async () => undefined }, evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
  const publication = createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 });
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
    sourceSemanticsPort: client.sourceSemanticsPort, sourceSemanticPublication: { publish: input => publication.publish(input) } });
  await client.ready();
  return { database, client, handler, admission, stores, filename };
}

type Session = Awaited<ReturnType<typeof openNativeSession>>;
async function publicInterpretation(session: Session, args: Record<string, unknown>) {
  const result = await callAlayaMcpMemoryTool({ memoryToolHandler: session.handler, contextProvider: () => context },
    "soul.interpretation", SoulInterpretationRequestSchema.parse({ ...args, budget: BUDGET, authorized_scopes: SCOPES }));
  expect(result.isError).not.toBe(true);
  const envelope = result.structuredContent;
  if (envelope === undefined || !("output" in envelope)) throw new Error("public MCP interpretation output required");
  const output = SoulInterpretationResponseSchema.parse(envelope.output);
  expect(output.provider_attempts).toBe(0);
  return output;
}

async function admit(session: Session, version = "1") {
  await session.admission.admit({ workspace_id: WS, source_id: SOURCE_ID, source_version: version,
    content_bytes: SOURCE, evidence_object_id: null, recorded_at: CLOCK, event_time: null,
    valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE) },
  { workspaceId: WS });
}

async function publishWorkshop(session: Session) {
  await admit(session);
  const prepared = await publicInterpretation(session, { operation: "prepare_source", source_id: SOURCE_ID });
  if (prepared.operation !== "prepare_source" || prepared.source_handle === undefined || prepared.catalog === undefined) {
    throw new Error("native source handle and catalog required");
  }
  const catalog = prepared.catalog;
  const quote = (text: string) => {
    expect(catalog.assertions[0]?.segments.some(row => row.text === text)).toBe(true);
    return { assertion_id: catalog.assertions[0]!.assertion_id, text };
  };
  const received = proposeSourceSemantics({ sourceCorpus: SOURCE, assertionIds: [1], source_id: SOURCE_ID,
    source_version: "1", producer_id: "test-author", producer_version: "1" }, { rawJson: JSON.stringify({
    contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" }, content: {
      roots: BRANCHES.map(row => ({ act: "assertion", expression: { kind: "content_ref", key: row.predicate } })),
      entities: BRANCHES.flatMap(row => [
        { form: "selection", key: row.person, selection: quote(row.person) },
        { form: "selection", key: row.thing, selection: quote(row.thing) }
      ]),
      nodes: BRANCHES.map(row => ({ kind: "statement", key: row.predicate,
        predicate: { kind: "explicit", reading: row.predicate, support: quote(row.verb) },
        arguments: [{ role: "agent", target: { kind: "entity_ref", key: row.person } },
          { role: "theme", target: { kind: "entity_ref", key: row.thing } }], qualifications: [] })), gaps: []
    }
  }) });
  expect(received.outcome.status).toBe("interpreted");
  const proposed = await publicInterpretation(session, { operation: "propose", source_handle: prepared.source_handle,
    draft: received.draft, producer_id: "test-author", producer_version: "1", contract_version: "source-interpretation-v4" });
  if (proposed.operation !== "propose" || proposed.published === undefined) throw new Error("native H publication required");
  return proposed.published;
}

function authoredScopedCorrespondences(query: SourceSemanticQuery, interpretation: SourceSemanticInterpretation, interpretationId: string) {
  const policies = sourceSemanticCorrespondenceGenerationPolicies(query,
    { kind: "query_branches", maximum_demands_per_interpretation: 2 });
  expect(policies).toEqual([0, 1].map(input => ({ contract: "source-semantic-correspondence-generation-policy-v1",
    kind: "branch_demand", alternative: 0, target: { kind: "evidence", input } })));
  return policies.map((generation_policy, input) => {
    const branch = BRANCHES[input]!;
    const sourceFrame = interpretation.frames.find(row => row.predicate_support.reading === branch.predicate)!;
    const proposal = { original_query: ORIGINAL, admitted_query_semantics: query, generation_policy,
      source_interpretation_descriptors: [{ source_interpretation_id: interpretationId, interpretation }],
      producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" };
    const request = buildSourceSemanticCorrespondenceRequest(proposal);
    expect(request.contract).toBe("source-semantic-correspondence-request-v9");
    if (request.demand === undefined) throw new Error("scoped correspondence request must carry its derived demand");
    expect(request.admitted_query_semantics).toEqual(query);
    expect(request.source_interpretation_descriptors[0]?.interpretation).toEqual(interpretation);
    // Independent coordinates: each branch advertises its predicate and two slots.
    expect(request.demand.demanded_handles).toEqual(request.catalog.query_endpoints
      .filter(row => row.frame === branch.frame).map(row => row.handle));
    expect(request.catalog.query_endpoints).toHaveLength(6);
    const assessments = request.catalog.query_endpoints.filter(row => row.frame === branch.frame).map(endpoint => {
      const role = endpoint.slot;
      const sourceSlot = sourceFrame.slots.find(row => row.role_reading === role);
      const sourceEndpoint = request.catalog.source_endpoints.find(row => row.frame === sourceFrame.id
        && (role === undefined ? row.kind === "frame" : row.kind === "slot" && row.slot === sourceSlot?.id))!;
      const text = role === "agent" ? branch.person : role === "theme" ? branch.thing : branch.verb;
      const lexical = interpretation.mentions.find(row => row.text === text)!;
      return { query: endpoint.handle, status: "supported", equivalents: [{ source: sourceEndpoint.handle,
        ...(role === undefined ? { query_excerpt: branch.query } : {}),
        source_semantic_support: [{ kind: "lexical", mentions: [lexical.id] }], grounding: `Authored ${branch.predicate} premise.` }] };
    });
    const rawJson = JSON.stringify({ decision: "assess", assessments });
    const received = proposeCorrespondenceSemantics(proposal, { rawJson });
    expect(received.rawJson).toBe(rawJson);
    expect(received.outcome, JSON.stringify(received.outcome)).toMatchObject({ status: "interpreted" });
    expect(received.coverage).toMatchObject({ assessed: request.demand.demanded_handles,
      supported: request.demand.demanded_handles, unresolved: [] });
    expect(received.coverage?.unassessed).toHaveLength(3);
    if (received.semantic_correspondence === undefined) throw new Error("scoped native C receiver required");
    expect(received.semantic_correspondence.correspondences).toHaveLength(3);
    return received.semantic_correspondence;
  });
}

function returnedText(proof: SourceSemanticLibraryProof, nodeId: string | undefined) {
  const referent = proof.interpretation.referents.find(row => row.id === nodeId);
  return proof.interpretation.mentions.filter(row => referent?.mentions.includes(row.id)).map(row => row.text).join(" ");
}

function expectPartialBranch(proof: SourceSemanticLibraryProof, input: number, correspondenceId: string) {
  expect(proof.semantic_correspondence_id).toBe(correspondenceId);
  expect(proof.original_query).toBe(ORIGINAL);
  expect(proof.query_gaps).toEqual(QUERY_GAPS);
  expect(proof.query.gaps).toEqual(QUERY_GAPS);
  expect(proof).toMatchObject({ world_claim: "unknown", semantic_status: "unreviewed",
    conclusion_scope: "conditional_on_interpretation" });
  expect(proof.binding_results).toHaveLength(1);
  const binding = proof.binding_results![0]!;
  expect(binding).toMatchObject({ kind: "evidence", input, query_complete: false });
  expect(returnedText(proof, binding.returned.person?.node_id)).toBe(BRANCHES[input]!.person);
  expect(returnedText(proof, binding.returned.thing?.node_id)).toBe(BRANCHES[input]!.thing);
  expect(proof.consumed_leaves.some(row => row.leaf_kind === "source_interpretation_binding")).toBe(true);
}

async function recall(session: Session, query: SourceSemanticQuery, semantic_correspondences: ReturnType<typeof authoredScopedCorrespondences>, original_query = ORIGINAL) {
  const output = await publicInterpretation(session, { operation: "recall", accepts_unreviewed_conditional_results: true,
    original_query, query_semantics: query, semantic_correspondences, output_byte_limit: 1_000_000 });
  if (output.operation !== "recall") throw new Error("public native recall required");
  return output;
}

it("keeps two scoped C for one Q/H as independent partial evidence proofs and withdraws only the exact C", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scoped-correspondence-native-"));
  const filename = join(directory, "alaya.db");
  let session: Session | undefined;
  try {
    session = await openNativeSession(filename);
    const published = await publishWorkshop(session);
    const query = authoredQuery();
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
    session = await openNativeSession(filename);
    const prepared = await publicInterpretation(session, { operation: "prepare_query", original_query: ORIGINAL, query_semantics: query });
    if (prepared.operation !== "prepare_query") throw new Error("native prepare_query required");
    expect(prepared.candidates.some(row => row.interpretation_id === published.interpretation_id)).toBe(true);
    const scoped = authoredScopedCorrespondences(query, published.interpretation, published.interpretation_id);
    const ids = scoped.map(row => sourceSemanticCorrespondenceIdentity(row, fieldContractSha256));
    expect(new Set(ids).size).toBe(2);
    const both = await recall(session, query, scoped);
    expect(both.proofs).toHaveLength(2);
    expect(both.index?.entries).toHaveLength(1);
    expect(both.proofs?.map(row => row.source_interpretation_id)).toEqual([published.interpretation_id, published.interpretation_id]);
    const sourceRecord = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    for (const input of [0, 1]) {
      const proof = both.proofs!.find(row => row.semantic_correspondence_id === ids[input])!;
      expectPartialBranch(proof, input, ids[input]!);
      const qualifier = both.slot_qualifiers?.find(row => row.semantic_correspondence_id === ids[input]);
      expect(qualifier?.witnesses?.map(row => row.binding_id)).toEqual([proof.binding_results![0]!.binding_id]);
      expect(qualifier?.support).toMatchObject({ answer: "unrepresented", operation: "not_executed",
        compatibility: "unknown", distinctness: "unknown" });
      expect(qualifier?.support?.evidence_inputs).toEqual([0, 1].map(branch => ({
        alternative: 0, input: branch, status: branch === input ? "supported" : "open"
      })));
      expect(qualifier).toMatchObject({ index: 0, source_interpretation_id: published.interpretation_id,
        query_semantics_id: proof.query_semantics_id, conditional_computation_id: proof.conditional_computation_id,
        payload_support: "available" });
      const index = both.index!, entry = index.entries[qualifier!.index]!;
      const verified = deliveredSourceSemanticLibraryProof(index, entry, qualifier!, both.proofs!, sourceRecord);
      expect(verified.proof).toBe(proof);
      expect(verified.verified_proofs).toEqual([proof]);
      const other = both.slot_qualifiers!.find(row => row.semantic_correspondence_id === ids[1 - input])!;
      expect(deliveredSourceSemanticLibraryProof(index, entry, { ...qualifier!, witnesses: other.witnesses },
        both.proofs!, sourceRecord).proof).toBeUndefined();
    }
    expect(both.slot_qualifiers?.filter(row => row.evidence_kind === "semantic_proof")).toHaveLength(2);
    for (const retained of [0, 1]) {
      const withdrawn = await recall(session, query, [scoped[retained]!]);
      expect(withdrawn.proofs).toHaveLength(1);
      expectPartialBranch(withdrawn.proofs![0]!, retained, ids[retained]!);
      expect(withdrawn.proofs?.some(row => row.semantic_correspondence_id === ids[1 - retained])).toBe(false);
      expect(withdrawn.slot_qualifiers?.some(row => row.semantic_correspondence_id === ids[1 - retained])).toBe(false);
      expect(withdrawn.slot_qualifiers?.find(row => row.semantic_correspondence_id === ids[retained])?.support)
        .toMatchObject({ answer: "unrepresented", operation: "not_executed" });
    }
    const fallback = await recall(session, query, []);
    expect(fallback.proofs ?? []).toEqual([]);
    expect(fallback.slot_qualifiers?.some(row => row.evidence_kind === "source_evidence")).toBe(true);
    expect(JSON.stringify(fallback)).toContain(SOURCE);
    expect(session.database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
    expect(isolation.forbidden).toEqual([]);
  } finally {
    if (session !== undefined) { await session.client.close(); session.database.close(); closeCachedDatabase(filename); }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("rejects a scoped C replay against another Q or a stale H while retaining current original-source evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scoped-correspondence-replay-"));
  const filename = join(directory, "alaya.db");
  const session = await openNativeSession(filename);
  try {
    const published = await publishWorkshop(session);
    const query = authoredQuery();
    const scoped = authoredScopedCorrespondences(query, published.interpretation, published.interpretation_id);
    expect((await recall(session, query, scoped)).proofs).toHaveLength(2);
    // A consequent demand retains its conditional owner and the governing antecedent.
    const governedOriginal = `If someone used tools, ${ORIGINAL}`;
    const governedQuery = authoredQuerySemantics({ original_query: governedOriginal,
      producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
      variables: [...query.variables, { id: "conditionEvent", sort: "context" }],
      alternatives: [{ frames: [{ id: "qIf", variable: "conditionEvent", predicate_reading: "conditional",
        operator: "conditional", role_requirements: [] }, ...query.alternatives[0]!.frames],
        context_obligations: [{ frame: "qIf", kind: "asserted_at_source" },
          { frame: "qUse", kind: "explicit_embedded_structure",
            incidence: { kind: "operator_operand", other_frame: "qIf", role: "antecedent" } },
          { frame: "qRepair", kind: "explicit_embedded_structure",
            incidence: { kind: "operator_operand", other_frame: "qIf", role: "consequent" } }],
        answer_frames: [], evidence_inputs: [{ frames: ["qRepair"] }] }],
      return_variables: query.return_variables, gaps: QUERY_GAPS, requested_operation: query.requested_operation
    }).query;
    const governedPreparation = await publicInterpretation(session, { operation: "prepare_query",
      original_query: governedOriginal, query_semantics: governedQuery });
    expect(governedPreparation.operation).toBe("prepare_query");
    const [generation_policy] = sourceSemanticCorrespondenceGenerationPolicies(governedQuery,
      { kind: "query_branches", maximum_demands_per_interpretation: 1 });
    const governedRequest = buildSourceSemanticCorrespondenceRequest({ original_query: governedOriginal,
      admitted_query_semantics: governedQuery, generation_policy,
      source_interpretation_descriptors: [{ source_interpretation_id: published.interpretation_id, interpretation: published.interpretation }],
      producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" });
    if (governedRequest.demand === undefined) throw new Error("governed branch request must carry its derived demand");
    expect(governedRequest.demand.query_refs.frames).toEqual(["qIf", "qUse", "qRepair"]);
    expect(governedRequest.demand.demanded_handles).toEqual(governedRequest.catalog.query_endpoints.map(row => row.handle));
    expect(governedRequest.admitted_query_semantics).toEqual(governedQuery);
    const otherOriginal = `${ORIGINAL.slice(0, -1)}, please.`;
    const otherQuery = authoredQuery(otherOriginal);
    expect(otherQuery.original_query_digest).not.toBe(query.original_query_digest);
    const crossQuery = await recall(session, otherQuery, scoped, otherOriginal);
    expect(crossQuery.proofs ?? []).toEqual([]);
    expect(crossQuery.slot_qualifiers?.some(row => row.evidence_kind === "semantic_proof")).toBe(false);
    expect(crossQuery.slot_qualifiers?.some(row => row.evidence_kind === "source_evidence")).toBe(true);
    await admit(session, "2");
    const stale = await recall(session, query, scoped);
    expect(stale.proofs ?? []).toEqual([]);
    expect(stale.slot_qualifiers?.some(row => row.evidence_kind === "semantic_proof")).toBe(false);
    expect(stale.slot_qualifiers?.some(row => row.evidence_kind === "source_evidence")).toBe(true);
    expect(isolation.forbidden).toEqual([]);
  } finally {
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
