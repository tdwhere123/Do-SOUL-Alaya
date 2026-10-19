import { sourceSemanticExecutionPhases } from "@do-soul/alaya-protocol";
import { afterAll, expect, it, vi } from "vitest";

// Mechanism test: authored outputs only. Install guards before application imports.
const isolation = await vi.hoisted(async () => {
  const loaded = await Promise.all([import("node:http"), import("node:https"), import("node:net"), import("node:tls"),
    import("node:http2"), import("node:dgram"), import("node:fs"), import("node:fs/promises"), import("node:module")]);
  // A closure-free installer lets the native worker install the same restrictions before application imports.
  function install(modules: typeof loaded) {
    const [{ default: http }, { default: https }, { default: net }, { default: tls },
      { default: http2 }, { default: dgram }, { default: fs }, { default: fsp }, { syncBuiltinESMExports }] = modules;
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
  }
  const parent = install(loaded);
  const { default: workers } = await import("node:worker_threads");
  const counters = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const bootstrap = `const modules = await Promise.all(${JSON.stringify(["node:http", "node:https", "node:net", "node:tls",
    "node:http2", "node:dgram", "node:fs", "node:fs/promises", "node:module"])}.map(id => import(id)));
    const guard = (${install.toString()})(modules);
    const { workerData } = await import("node:worker_threads");
    const counts = new Int32Array(workerData.authoredGuardCounters);
    const push = guard.forbidden.push.bind(guard.forbidden);
    guard.forbidden.push = (...items) => { Atomics.add(counts, 2, items.length); return push(...items); };
    Atomics.add(counts, 1, 1);`;
  const descriptor = Object.getOwnPropertyDescriptor(workers, "Worker")!;
  Object.defineProperty(workers, "Worker", { ...descriptor, value: new Proxy(workers.Worker, {
    construct(target, args, newTarget) {
      const options = (args[1] ?? {}) as import("node:worker_threads").WorkerOptions;
      const worker = Reflect.construct(target, [args[0], { ...options,
        execArgv: [...(options.execArgv ?? process.execArgv), "--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`],
        workerData: { ...options.workerData, authoredGuardCounters: counters.buffer } }], newTarget);
      Atomics.add(counters, 0, 1);
      return worker;
    }
  }) });
  loaded[8].syncBuiltinESMExports();
  return { forbidden: parent.forbidden, counters, restore: () => {
    Object.defineProperty(workers, "Worker", descriptor); parent.restore();
  } };
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  sourceSemanticCorrespondenceGenerationPolicies, sourceSemanticCorrespondenceIdentity,
  type SourceReferenceCatalog, type SourceSemanticInterpretation, type SourceSemanticLibraryProof, type SourceSemanticQuery
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
import { authoredQuerySemantics, receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";

afterAll(() => {
  try {
    expect(isolation.forbidden).toEqual([]);
    expect(Atomics.load(isolation.counters, 0)).toBeGreaterThan(0);
    expect(Atomics.load(isolation.counters, 1)).toBe(Atomics.load(isolation.counters, 0));
    expect(Atomics.load(isolation.counters, 2)).toBe(0);
  } finally { isolation.restore(); }
});

const CLOCK = "2026-09-21T10:00:00.000Z";
const SOURCE = "Alice uses tools and Bob repairs lathes.";
const SOURCE_ID = "artifact-workshop";
const ORIGINAL = "Give five examples of who used tools or repaired lathes.";
const BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };
const WINDOW_BUDGET = { ...BUDGET, work_units: 1_000_000 };
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
    "soul.interpretation", SoulInterpretationRequestSchema.parse({ budget: BUDGET, ...args, authorized_scopes: SCOPES }));
  expect(result.isError).not.toBe(true);
  const envelope = result.structuredContent;
  if (envelope === undefined || !("output" in envelope)) throw new Error("public MCP interpretation output required");
  const output = SoulInterpretationResponseSchema.parse(envelope.output);
  expect(sourceSemanticExecutionPhases(output.execution).query_preparation.external_api_attempts).toBe(0);
  return output;
}

async function admit(session: Session, version = "1", source = SOURCE) {
  await session.admission.admit({ workspace_id: WS, source_id: SOURCE_ID, source_version: version,
    content_bytes: source, evidence_object_id: null, recorded_at: CLOCK, event_time: null,
    valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(source) },
  { workspaceId: WS });
}

async function publishSource(session: Session, source: string, content: (catalog: SourceReferenceCatalog) => unknown) {
  await admit(session, "1", source);
  const prepared = await publicInterpretation(session, { operation: "prepare_source", source_id: SOURCE_ID });
  if (prepared.operation !== "prepare_source" || prepared.source_handle === undefined || prepared.catalog === undefined) {
    throw new Error("native source handle and catalog required");
  }
  const received = proposeSourceSemantics({ sourceCorpus: source,
    assertionIds: prepared.catalog.assertions.map(row => row.assertion_id), source_id: SOURCE_ID,
    source_version: "1", producer_id: "test-author", producer_version: "1" }, { rawJson: JSON.stringify({
    contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" }, content: content(prepared.catalog)
  }) });
  expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
  const proposed = await publicInterpretation(session, { operation: "propose", source_handle: prepared.source_handle,
    draft: received.draft, producer_id: "test-author", producer_version: "1", contract_version: "source-interpretation-v4" });
  if (proposed.operation !== "propose" || proposed.published === undefined) throw new Error("native H publication required");
  return proposed.published;
}

function sourceQuote(catalog: SourceReferenceCatalog, text: string, alongside = text) {
  const assertion = catalog.assertions.find(row => row.segments.some(segment => segment.text === text)
    && row.segments.some(segment => segment.text === alongside));
  expect(assertion).toBeDefined();
  return { assertion_id: assertion!.assertion_id, text };
}

async function publishWorkshop(session: Session, source = SOURCE) {
  return publishSource(session, source, catalog => {
    const quote = (text: string) => sourceQuote(catalog, text);
    return {
      roots: BRANCHES.map(row => ({ act: "assertion", expression: { kind: "content_ref", key: row.predicate } })),
      entities: BRANCHES.flatMap(row => [
        { form: "selection", key: row.person, selection: quote(row.person) },
        { form: "selection", key: row.thing, selection: quote(row.thing) }
      ]),
      nodes: BRANCHES.map(row => ({ kind: "statement", key: row.predicate,
        predicate: { kind: "explicit", reading: row.predicate, support: quote(row.verb) },
        arguments: [{ role: "agent", target: { kind: "entity_ref", key: row.person } },
          { role: "theme", target: { kind: "entity_ref", key: row.thing } }], qualifications: [] })), gaps: []
    };
  });
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

async function recall(session: Session, query: SourceSemanticQuery, semantic_correspondences: ReturnType<typeof authoredScopedCorrespondences>, original_query = ORIGINAL, budget = BUDGET) {
  const output = await publicInterpretation(session, { operation: "recall", accepts_unreviewed_conditional_results: true,
    original_query, query_semantics: query, semantic_correspondences, budget, output_byte_limit: 1_000_000 });
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

it("delivers an intact scoped proof when independent same-source proofs exceed one display window", async () => {
  const source = `Alice uses tools.\n${"x".repeat(5000)}.\nBob repairs lathes.`;
  const directory = await mkdtemp(join(tmpdir(), "scoped-proof-window-"));
  const filename = join(directory, "alaya.db");
  let session = await openNativeSession(filename);
  try {
    const published = await publishWorkshop(session, source);
    const query = authoredQuery();
    const scoped = authoredScopedCorrespondences(query, published.interpretation, published.interpretation_id);
    const ids = scoped.map(row => sourceSemanticCorrespondenceIdentity(row, fieldContractSha256));
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
    session = await openNativeSession(filename);
    const prepared = await publicInterpretation(session, { operation: "prepare_query", original_query: ORIGINAL,
      query_semantics: query, budget: WINDOW_BUDGET });
    if (prepared.operation !== "prepare_query") throw new Error("native prepare_query required");
    expect(prepared.candidates.some(row => row.interpretation_id === published.interpretation_id), JSON.stringify(prepared)).toBe(true);
    const sourceRecord = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    const expectedPreviews = ["Alice uses tools.", "Bob repairs lathes."];
    const singles: SourceSemanticLibraryProof[] = [];
    for (const input of [0, 1]) {
      const single = await recall(session, query, [scoped[input]!], ORIGINAL, WINDOW_BUDGET);
      expect(single.proofs).toHaveLength(1);
      const proof = single.proofs![0]!;
      expectPartialBranch(proof, input, ids[input]!);
      const qualifier = single.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
      const entry = single.index!.entries[qualifier.index]!;
      expect(single.results?.[qualifier.index]?.content_preview).toBe(expectedPreviews[input]);
      expect(entry.target).toMatchObject({ span: { content_start: source.indexOf(expectedPreviews[input]!),
        content_end: source.indexOf(expectedPreviews[input]!) + expectedPreviews[input]!.length } });
      expect(deliveredSourceSemanticLibraryProof(single.index!, entry, qualifier, single.proofs!, sourceRecord).proof).toBe(proof);
      singles.push(proof);
    }
    const both = await recall(session, query, scoped, ORIGINAL, WINDOW_BUDGET);
    expect(both.proofs).toHaveLength(1);
    expect(both.index?.entries).toHaveLength(1);
    expect(both.slot_qualifiers).toHaveLength(1);
    expect(both.index?.continuation).toBeNull();
    const proof = both.proofs![0]!;
    const input = ids.indexOf(proof.semantic_correspondence_id!);
    expect(input).toBeGreaterThanOrEqual(0);
    expect(proof).toEqual(singles[input]);
    const qualifier = both.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
    expect(qualifier.support).toMatchObject({ answer: "unrepresented", operation: "not_executed",
      compatibility: "unknown", distinctness: "unknown",
      evidence_inputs: [0, 1].map(branch => ({ alternative: 0, input: branch, status: branch === input ? "supported" : "open" })) });
    expect(both.results?.[qualifier.index]?.content_preview).toBe(expectedPreviews[input]);
    expect(qualifier.witnesses?.map(row => row.binding_id)).toEqual([proof.binding_results![0]!.binding_id]);
    expect(deliveredSourceSemanticLibraryProof(both.index!, both.index!.entries[qualifier.index]!, qualifier,
      both.proofs!, sourceRecord).proof).toBe(proof);
    const broad = { ...scoped[0]!, correspondences: scoped.flatMap(row => row.correspondences) };
    const broadReason = await publicInterpretation(session, { operation: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: published.interpretation_id, original_query: ORIGINAL, query_semantics: query,
      semantic_correspondence: broad, output_byte_limit: 1_000_000, budget: WINDOW_BUDGET });
    if (broadReason.operation !== "reason") throw new Error("native broad correspondence required");
    expect(broadReason.result?.binding_results).toHaveLength(2);
    const indivisible = await recall(session, query, [broad], ORIGINAL, WINDOW_BUDGET);
    expect(indivisible.proofs ?? []).toEqual([]);
    expect(indivisible.slot_qualifiers).toEqual([expect.objectContaining({ evidence_kind: "source_evidence", payload_support: "display_budget" })]);
    const mixed = await recall(session, query, [broad, scoped[0]!], ORIGINAL, WINDOW_BUDGET);
    expect(mixed.proofs).toEqual([singles[0]]);
    const mixedQualifier = mixed.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
    expect(deliveredSourceSemanticLibraryProof(mixed.index!, mixed.index!.entries[mixedQualifier.index]!, mixedQualifier,
      mixed.proofs!, sourceRecord).proof).toBe(mixed.proofs![0]);
    const raw = await recall(session, query, [], ORIGINAL, WINDOW_BUDGET);
    expect(raw.proofs ?? []).toEqual([]);
    expect(raw.slot_qualifiers?.some(row => row.evidence_kind === "source_evidence")).toBe(true);
    expect(raw.results?.[0]?.content_preview).toContain("Alice uses tools.");
    expect(isolation.forbidden).toEqual([]);
  } finally {
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

const PARCEL_QUERY = "which parcel was sent and inspected?";
const PARCEL_FRAMES = [
  { query: "qSend", variable: "sendEvent", predicate: "send", verb: "sent" },
  { query: "qInspect", variable: "inspectEvent", predicate: "inspect", verb: "inspected" }
] as const;

function parcelQuery() {
  return authoredQuerySemantics({ original_query: PARCEL_QUERY,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
    variables: [{ id: "parcel", sort: "entity" }, ...PARCEL_FRAMES.map(row => ({ id: row.variable, sort: "proposition" }))],
    alternatives: [{ frames: PARCEL_FRAMES.map(row => ({ id: row.query, variable: row.variable,
      predicate_reading: row.predicate, role_requirements: [{ id: "object", role_reading: "object", target_variable: "parcel",
        support: { kind: "query_text", excerpt: "parcel" } }] })),
      context_obligations: PARCEL_FRAMES.map(row => ({ frame: row.query, kind: "asserted_at_source" })) }],
    return_variables: ["parcel"], gaps: []
  }).query;
}

function publishParcel(session: Session, source: string) {
  return publishSource(session, source, catalog => ({
    roots: PARCEL_FRAMES.map(row => ({ act: "assertion", expression: { kind: "content_ref", key: row.predicate } })),
    entities: [{ form: "entity", key: "parcel", referent_kind: "grouped",
      mentions: PARCEL_FRAMES.map(row => sourceQuote(catalog, "Parcel", row.verb)) }],
    nodes: PARCEL_FRAMES.map(row => ({ kind: "statement", key: row.predicate,
      predicate: { kind: "explicit", reading: row.predicate, support: sourceQuote(catalog, row.verb) },
      arguments: [{ role: "object", target: { kind: "entity_ref", key: "parcel" },
        support: sourceQuote(catalog, "Parcel", row.verb) }], qualifications: [] })), gaps: []
  }));
}

function parcelCorrespondence(query: SourceSemanticQuery, published: Awaited<ReturnType<typeof publishParcel>>, original_query = PARCEL_QUERY) {
  const received = receiveAuthoredCorrespondence({ original_query, admitted_query_semantics: query,
    source_interpretation_descriptors: [{ source_interpretation_id: published.interpretation_id, interpretation: published.interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, {
    correspondences: PARCEL_FRAMES.filter(row => query.alternatives[0]!.frames.some(frame => frame.id === row.query)).flatMap(row => {
      const frame = published.interpretation.frames.find(frame => frame.predicate_support.reading === row.predicate)!;
      if (frame.predicate_support.kind !== "explicit") throw new Error("parcel predicate requires its source mention");
      const slot = frame.slots.find(slot => slot.role_reading === "object")!;
      return [{ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: row.query },
        source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: row.verb },
        source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: row.query, slot: "object" },
        source_endpoint: { kind: "slot", frame: frame.id, slot: slot.id }, query_support: { kind: "query_text", excerpt: "parcel" },
        source_semantic_support: slot.support }];
    })
  });
  expect(received.outcome.status).toBe("interpreted");
  if (received.semantic_correspondence === undefined) throw new Error("connected parcel correspondence required");
  return received.semantic_correspondence;
}

it.each([0, 5000])("keeps both dependencies of one shared-parcel conjunction indivisible (gap %i)", async gap => {
  const source = `Parcel sent.\n${gap === 0 ? "" : `${"x".repeat(gap)}.\n`}Parcel inspected.`;
  const directory = await mkdtemp(join(tmpdir(), "conjunctive-proof-window-"));
  const filename = join(directory, "alaya.db");
  let session = await openNativeSession(filename);
  try {
    const published = await publishParcel(session, source);
    const query = parcelQuery(), correspondence = parcelCorrespondence(query, published);
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
    session = await openNativeSession(filename);
    const reason = await publicInterpretation(session, { operation: "reason", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: published.interpretation_id, original_query: PARCEL_QUERY, query_semantics: query,
      semantic_correspondence: correspondence, output_byte_limit: 1_000_000, budget: WINDOW_BUDGET });
    if (reason.operation !== "reason") throw new Error("native connected conjunction required");
    expect(reason.result?.binding_results).toHaveLength(1);
    expect(Object.keys(reason.result!.binding_results![0]!.returned)).toEqual(["parcel"]);
    const full = await recall(session, query, [correspondence], PARCEL_QUERY, WINDOW_BUDGET);
    if (gap === 0) {
      expect(full.proofs).toHaveLength(1);
      const qualifier = full.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
      const entry = full.index!.entries[qualifier.index]!;
      const sourceRecord = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
      expect(full.results?.[qualifier.index]?.content_preview).toBe(source);
      expect(deliveredSourceSemanticLibraryProof(full.index!, entry, qualifier, full.proofs!, sourceRecord).proof).toBe(full.proofs![0]);
      if (entry.target.kind !== "source_evidence" || entry.target.span === undefined) throw new Error("source span required");
      for (const span of [{ content_start: 0, content_end: "Parcel sent.".length },
        { content_start: source.indexOf("Parcel inspected."), content_end: source.length }]) {
        const clipped = { ...entry, target: { ...entry.target, span: { ...entry.target.span, ...span, content_complete: false } } };
        expect(deliveredSourceSemanticLibraryProof(full.index!, clipped, qualifier, full.proofs!, sourceRecord).proof).toBeUndefined();
      }
    } else {
      expect(full.proofs ?? []).toEqual([]);
      expect(full.slot_qualifiers).toEqual([expect.objectContaining({ evidence_kind: "source_evidence", payload_support: "display_budget" })]);
    }
    for (const missing of PARCEL_FRAMES) {
      const incomplete = { ...correspondence, correspondences: correspondence.correspondences.filter(row =>
        row.query_endpoint.kind !== "predicate" || row.query_endpoint.frame !== missing.query) };
      const withdrawn = await recall(session, query, [incomplete], PARCEL_QUERY, WINDOW_BUDGET);
      expect(withdrawn.proofs ?? []).toEqual([]);
      expect(withdrawn.unproved_computations).toEqual([expect.objectContaining({ kind: "complete_zero_binding" })]);
      expect(withdrawn.slot_qualifiers?.some(row => row.evidence_kind === "source_evidence")).toBe(true);
    }
    expect(isolation.forbidden).toEqual([]);
  } finally {
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("requires full-denotation referent C while explicit shared-variable attributes consume separate predicate premises", async () => {
  // Finite authored domain: one parcel, both properties; the full description denotes exactly that parcel.
  const source = "Parcel sent. The same Parcel inspected.";
  const original = "Find the sent and inspected parcel.";
  const directory = await mkdtemp(join(tmpdir(), "parcel-reference-dependency-"));
  const filename = join(directory, "alaya.db");
  const session = await openNativeSession(filename);
  try {
    const published = await publishParcel(session, source);
    const explicit = parcelQuery();
    const reference = { kind: "query_text" as const, excerpt: "the sent and inspected parcel" };
    const named = authoredQuerySemantics({ original_query: original,
      producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
      variables: [{ id: "parcel", sort: "entity", reference }, { id: "sendEvent", sort: "proposition" }],
      alternatives: [{ frames: [explicit.alternatives[0]!.frames[0]],
        context_obligations: [{ frame: "qSend", kind: "asserted_at_source" }] }],
      return_variables: ["parcel"], gaps: [],
      requested_operation: { reading: "find", support: { kind: "query_text", excerpt: "Find" } }
    }).query;
    const ordinary = parcelCorrespondence(named, published, original);
    const referent = published.interpretation.referents[0]!;
    // C supplies the full description, including inspected; K does not independently verify that adjective.
    const received = receiveAuthoredCorrespondence({ original_query: original, admitted_query_semantics: named,
      source_interpretation_descriptors: [{ source_interpretation_id: published.interpretation_id, interpretation: published.interpretation }],
      producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" }, {
      correspondences: [...ordinary.correspondences, { relation: "contextual_equivalence",
        query_endpoint: { kind: "referent", variable: "parcel" }, source_endpoint: { kind: "referent", referent: referent.id },
        query_support: reference, source_semantic_support: [{ kind: "lexical", mentions: published.interpretation.mentions.map(row => row.id) }] }]
    });
    expect(received.outcome.status).toBe("interpreted");
    if (received.semantic_correspondence === undefined) throw new Error("full description correspondence required");
    const complete = received.semantic_correspondence;
    const frozenInputs = JSON.stringify({ source, explicit, named, ordinary, complete });
    const sourceRecord = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    const proofs: SourceSemanticLibraryProof[] = [];
    for (const [query, correspondence, text] of [[explicit, parcelCorrespondence(explicit, published), PARCEL_QUERY],
      [named, complete, original]] as const) {
      const result = await recall(session, query, [correspondence], text, WINDOW_BUDGET);
      expect(result.proofs).toHaveLength(1);
      const qualifier = result.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
      const proof = deliveredSourceSemanticLibraryProof(result.index!, result.index!.entries[qualifier.index]!, qualifier,
        result.proofs!, sourceRecord).proof!;
      expect(proof).toBe(result.proofs![0]);
      expect(proof).toMatchObject({ world_claim: "unknown", semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation" });
      expect(proof.binding_results).toHaveLength(1);
      expect(proof.binding_results![0]).toMatchObject({ kind: "answer", query_complete: true,
        returned: { parcel: { node_id: referent.id } } });
      expect(result.results?.[qualifier.index]?.content_preview).toBe(source);
      expect(qualifier.support?.operation).toBe(query.requested_operation === undefined ? "not_requested" : "not_executed");
      const entry = result.index!.entries[qualifier.index]!;
      expect(entry.target).toMatchObject({ kind: "source_evidence", span: { content_start: 0, content_end: source.length } });
      proofs.push(proof);
    }
    expect(proofs[0]!.consumed_leaves.filter(row => row.leaf_kind === "semantic_correspondence_predicate")).toHaveLength(2);
    expect(proofs[0]!.consumed_leaves.filter(row => row.leaf_kind === "semantic_correspondence_referent")).toEqual([]);
    expect(proofs[1]!.consumed_leaves.filter(row => row.leaf_kind === "semantic_correspondence_predicate")).toHaveLength(1);
    expect(proofs[1]!.consumed_leaves).toContainEqual(expect.objectContaining({ leaf_kind: "semantic_correspondence_referent",
      correspondence_index: complete.correspondences.findIndex(row => row.query_endpoint.kind === "referent") }));
    // Only referent C is absent: the independently true sent predicate and object-slot C survive.
    expect(ordinary.correspondences).toEqual(complete.correspondences.filter(row => row.query_endpoint.kind !== "referent"));
    const withdrawn = await recall(session, named, [ordinary], original, WINDOW_BUDGET);
    expect(withdrawn.proofs ?? []).toEqual([]);
    expect(withdrawn.unproved_computations).toEqual([expect.objectContaining({ kind: "complete_zero_binding" })]);
    expect(withdrawn.slot_qualifiers).toEqual([expect.objectContaining({ evidence_kind: "source_evidence" })]);
    expect(withdrawn.results?.[0]?.content_preview).toBe(source);
    expect(JSON.stringify({ source, explicit, named, ordinary, complete })).toBe(frozenInputs);
  } finally {
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("does not join individually supported predicates on two explicitly different parcels into one shared witness", async () => {
  // Finite authored domain: Alpha != Beta, sent only Alpha, inspected only Beta; no shared witness is established.
  const source = "Alpha sent. Beta inspected. Alpha and Beta are different parcels.";
  const directory = await mkdtemp(join(tmpdir(), "different-parcel-witnesses-"));
  const filename = join(directory, "alaya.db");
  const session = await openNativeSession(filename);
  try {
    const published = await publishSource(session, source, catalog => ({
      roots: [...PARCEL_FRAMES.map(row => ({ act: "assertion", expression: { kind: "content_ref", key: row.predicate } })),
        { act: "assertion", expression: { kind: "content_ref", key: "different" } }],
      entities: ["Alpha", "Beta"].map(key => ({ form: "entity", key, referent_kind: "grouped",
        mentions: [sourceQuote(catalog, key, key === "Alpha" ? "sent" : "inspected"), sourceQuote(catalog, key, "different")] })),
      nodes: [...PARCEL_FRAMES.map((row, index) => ({ kind: "statement", key: row.predicate,
        predicate: { kind: "explicit", reading: row.predicate, support: sourceQuote(catalog, row.verb) },
        arguments: [{ role: "object", target: { kind: "entity_ref", key: index === 0 ? "Alpha" : "Beta" },
          support: sourceQuote(catalog, index === 0 ? "Alpha" : "Beta", row.verb) }], qualifications: [] })),
      { kind: "statement", key: "different", predicate: { kind: "explicit", reading: "different parcels", support: sourceQuote(catalog, "different") },
        arguments: ["Alpha", "Beta"].map((key, index) => ({ role: index === 0 ? "first" : "second",
          target: { kind: "entity_ref", key }, support: sourceQuote(catalog, key, "different") })), qualifications: [] }], gaps: []
    }));
    const query = parcelQuery(), correspondence = parcelCorrespondence(query, published);
    expect(correspondence.correspondences.filter(row => row.query_endpoint.kind === "predicate")).toHaveLength(2);
    expect(published.interpretation.referents).toHaveLength(2);
    const targets = PARCEL_FRAMES.map(row => published.interpretation.frames.find(frame => frame.predicate_support.reading === row.predicate)!.bindings[0]!.target);
    expect(targets[0]).not.toEqual(targets[1]);
    const frozenInputs = JSON.stringify({ source, query, correspondence, interpretation: published.interpretation });
    const sourceRecord = session.stores.getCurrentRecord(WS, SOURCE_ID)!;
    // Each predicate and its source binding is independently usable through the same delivered-proof consumer.
    for (const [index, frame] of query.alternatives[0]!.frames.entries()) {
      const single = authoredQuerySemantics({ original_query: PARCEL_QUERY,
        producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1" }, {
        ...query, alternatives: [{ frames: [frame], context_obligations: [{ frame: frame.id, kind: "asserted_at_source" }] }],
        gaps: [{ kind: "unsupported_meaning", affected_ids: [], support: [{ kind: "query_text", excerpt: PARCEL_FRAMES[1 - index]!.verb }],
          description: "Only one predicate is represented by this availability control." }]
      }).query;
      const available = await recall(session, single, [parcelCorrespondence(single, published)], PARCEL_QUERY, WINDOW_BUDGET);
      expect(available.proofs).toHaveLength(1);
      const qualifier = available.slot_qualifiers!.find(row => row.evidence_kind === "semantic_proof")!;
      const proof = deliveredSourceSemanticLibraryProof(available.index!, available.index!.entries[qualifier.index]!, qualifier,
        available.proofs!, sourceRecord).proof!;
      expect(proof.binding_results).toHaveLength(1);
      expect(proof.binding_results![0]).toMatchObject({ kind: "answer", query_complete: false });
      expect(returnedText(proof, proof.binding_results![0]!.returned.parcel?.node_id)).toBe(index === 0 ? "Alpha Alpha" : "Beta Beta");
      expect(proof).toMatchObject({ world_claim: "unknown", semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation" });
    }
    const combined = await recall(session, query, [correspondence], PARCEL_QUERY, WINDOW_BUDGET);
    expect(combined.proofs ?? []).toEqual([]);
    expect(combined.unproved_computations).toEqual([expect.objectContaining({ kind: "complete_zero_binding" })]);
    expect(combined.slot_qualifiers).toEqual([expect.objectContaining({ evidence_kind: "source_evidence" })]);
    expect(combined.results?.[0]?.content_preview).toBe(source);
    expect(JSON.stringify({ source, query, correspondence, interpretation: published.interpretation })).toBe(frozenInputs);
  } finally {
    await session.client.close(); session.database.close(); closeCachedDatabase(filename);
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
