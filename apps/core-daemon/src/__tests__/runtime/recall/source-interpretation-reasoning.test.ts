import { bindReceivedSourceInterpretationPayload, requireCompletePublicBind } from "./source-discovery-admitted-public-publication.js";
import { publishCorePublicSources } from "./source-discovery-native-publication.js";
import { OfficialApiGardenProvider, buildOfficialApiSourcePacketRequest } from "@do-soul/alaya-soul";
import { indexOfficialApiSourceAssertions } from "../../../../../../packages/soul/src/garden/triage/grounding/source-locator.js";
import { prepareSourceInterpretationPacketBatchLine }
  from "../../../../../bench-runner/src/runs/extraction/fill/batch/source-interpretation-packet.js";
import { publishOfflineBatchPacket } from "./source-interpretation-batch.test-support.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAuditedSourceAdmission, createSourceInterpretationPacketPublication, EvidenceService,
  fieldContractSha256 } from "@do-soul/alaya-core";
import { buildSourceReferenceCatalog, sourceReferenceResolver, sourceReferencePreparationCost, assertSourceInterpretationPacketProfile, hashLabeledIdentity, SourceInterpretationPacketSchema, SourceInterpretationReasoningResultSchema, sourceInterpretationProfileIdentity, sourceInterpretationRelationKey, type QueryProgram,
  type SourceInterpretationPacket, type SourceInterpretationReasoningRequest, type SourceInterpretationReasoningResult } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, SqliteFieldEraseBarrierRepo, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS, REAL_SQLITE_TEST_RUN_ID as RUN }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { encodeIndexResults } from "../../../mcp-memory/recall/recall-result.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const SENTENCES = ["Orion sent parcel P to Vega.", "Vega promised to inspect P.", "Parcel Q remained untouched: 中文🙂."];
const SOURCE = `User: ${SENTENCES.join(" ")}`;
const ASSERTIONS = indexOfficialApiSourceAssertions(SOURCE).map((row) => ({ assertion_id: row.assertion_id,
  text: row.text, source_span: [row.start, row.end] as const }));
const BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };

const PROFILE = { contract: "source-interpretation-profile-v1" as const, description: "Event roles in statements and embedded content",
  predicates: [{ symbol: "send", governing_roles: [], meaning: "Transfer a theme toward a recipient." },
    { symbol: "promise", governing_roles: ["content"], meaning: "A promisor commits to embedded content; not fulfillment." },
    { symbol: "inspect", governing_roles: [], meaning: "Examine a theme; asserted only when an independent root." }],
  roles: [{ symbol: "agent", meaning: "Actor of the nominated event." }, { symbol: "theme", meaning: "Object involved in the event." },
    { symbol: "recipient", meaning: "Receiver in a transfer." }, { symbol: "promisor", meaning: "Party making a commitment." },
    { symbol: "content", meaning: "Embedded proposition under its parent's scope." },
    { symbol: "accompaniment", meaning: "An associated independently asserted event; no scope implication." }] };
const PROFILE_ID = sourceInterpretationProfileIdentity(PROFILE, fieldContractSha256);

const SOURCE_CATALOG = buildSourceReferenceCatalog(fieldContractSha256(SOURCE), ASSERTIONS, fieldContractSha256);
const SOURCE_REFERENCES = sourceReferenceResolver(SOURCE_CATALOG, fieldContractSha256);
function sourceRef(assertionId: number, text: string) {
  const start = ASSERTIONS.find((row) => row.assertion_id === assertionId)!.text.indexOf(text);
  return SOURCE_REFERENCES.referenceForSpan(assertionId, [start, start + text.length]);
}
function packet(): SourceInterpretationPacket {
  const mention = (id: string, assertion_id: number, text: string) => ({ id, assertion_id, source_ref: sourceRef(assertion_id, text) });
  return SourceInterpretationPacketSchema.parse({ contract: "source-interpretation-v2", profile_id: PROFILE_ID, source_catalog_id: SOURCE_CATALOG.catalog_id,
    mentions: [mention("o1", 1, "Orion"), mention("v1", 1, "Vega"), mention("p1", 1, "parcel P"),
      mention("v2", 2, "Vega"), mention("p2", 2, "P"), mention("sendWord", 1, "sent"),
      mention("promiseWord", 2, "promised"), mention("inspectWord", 2, "inspect"), mention("q3", 2, "Parcel Q"), mention("unicode", 2, "中文🙂")],
    referents: [{ id: "Orion", mentions: ["o1"] }, { id: "Vega", mentions: ["v1", "v2"] }, { id: "P", mentions: ["p1", "p2"] }],
    propositions: [
      { id: "sending", predicate: "send", implicit: false, predicate_mentions: ["sendWord"], assertion_ids: [1],
        arguments: [{ role: "agent", target: "Orion" }, { role: "theme", target: "P" }, { role: "recipient", target: "Vega" }] },
      { id: "promising", predicate: "promise", implicit: false, predicate_mentions: ["promiseWord"], assertion_ids: [2],
        arguments: [{ role: "promisor", target: "Vega" }, { role: "content", target: "inspection" }] },
      { id: "inspection", predicate: "inspect", implicit: false, predicate_mentions: ["inspectWord"], assertion_ids: [2],
        arguments: [{ role: "agent", target: "Vega" }, { role: "theme", target: "P" }] }
    ], operators: [], roots: ["sending", "promising"] });
}

function rel(kind: Parameters<typeof sourceInterpretationRelationKey>[0], symbol: string, from: string, to: string): QueryProgram {
  return { schema_version: 1, kind: "relation", relation_kind: sourceInterpretationRelationKey(kind, symbol),
    source_variable: from, target_variable: to, guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved", time_scope: "none" },
    facet_mode: "same_path", threshold_milligrades: 0 };
}
const seq = (...steps: QueryProgram[]): QueryProgram => ({ schema_version: 1, kind: "sequence", steps });
const PROGRAM: QueryProgram = { schema_version: 1, kind: "hyperedge", join: "and", premises: [
  seq(rel("asserted", "send", "send", "send"), rel("role", "theme", "send", "parcel")),
  seq(rel("asserted", "send", "send", "send"), rel("role", "recipient", "send", "recipient"),
    rel("inverse_role", "promisor", "recipient", "promise"), rel("asserted", "promise", "promise", "promise"),
    rel("role", "content", "promise", "inspection"), rel("predicate", "inspect", "inspection", "inspection"),
    rel("role", "theme", "inspection", "parcel"))
] };

async function withPublishedPackets(packets: readonly SourceInterpretationPacket[], body: (input: {
  ids: readonly string[]; reason: (request: SourceInterpretationReasoningRequest) => Promise<SourceInterpretationReasoningResult>
}) => Promise<void>, options: Readonly<{ valid_from?: string; valid_to?: string; state?: "retired" | "erased" | "superseded";
  scope?: "project" | "global_core"; profile?: typeof PROFILE }> = {}) {
  const profile = options.profile ?? PROFILE;
  const directory = await mkdtemp(join(tmpdir(), "source-interpretation-reasoning-"));
  const filename = join(directory, "memory.sqlite");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  await admission.admit({ workspace_id: WS, source_id: "orion-parcel-source", source_version: "1", content_bytes: SOURCE,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: options.valid_from ?? null, valid_to: options.valid_to ?? null,
    speaker: "user", scope_class: options.scope ?? "project", spans: deriveAddressableSpanViews(SOURCE) }, { workspaceId: WS });
  const publisher = createSourceInterpretationPacketPublication({ stores, evidenceService, sha256: fieldContractSha256 });
  const ids = [];
  for (const proposal of packets) {
    const extractionRequest = buildOfficialApiSourcePacketRequest(SOURCE, ASSERTIONS.map((row) => row.assertion_id), profile);
    const rawJson = JSON.stringify({ contract: "source-interpretation-response-v2", packet: proposal });
    const line = prepareSourceInterpretationPacketBatchLine(extractionRequest, ["orion-fixture"], { model: "gemini-2.5-flash", requestProfile: "gemini-2.5-nonthinking-v1" });
    if (ids.length > 0) {
      ids.push(await publishOfflineBatchPacket({ directory: join(directory, `proposal-${ids.length}`), line, rawJson, sourceCorpus: SOURCE, artifactKey: "orion-parcel-source",
        publish: async (draft) => (await publisher.publish({ ...draft, workspaceId: WS, runId: RUN })).bound.packet_id }));
      continue;
    }
    const received = await new OfficialApiGardenProvider({ injectedExtractorCapability: "cache_only",
      diagnosticDir: null, extractor: { extract: async (input) => { input.validateRawJson?.(rawJson); return { rawJson }; } } })
      .extractSourcePacket(extractionRequest, { sourceCorpus: SOURCE, artifactKey: "orion-parcel-source" });
    if (received.status !== "received") throw new Error("independent packet was not received");
    const published = await publisher.publish({ ...received.draft, workspaceId: WS, runId: RUN });
    ids.push(published.bound.packet_id);
  }
  expect(database.connection.prepare("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
  expect(database.connection.prepare("SELECT count(*) AS n FROM relation_assertions").get()).toEqual({ n: 0 });
  if (options.state === "retired") database.connection.prepare("UPDATE evidence_capsules SET lifecycle_state='tombstone' WHERE workspace_id=?").run(WS);
  if (options.state === "superseded") await admission.admit({ workspace_id: WS, source_id: "orion-parcel-source",
    source_version: "2", content_bytes: SOURCE, evidence_object_id: null, recorded_at: "2026-09-19T00:00:00.000Z",
    event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(SOURCE) }, { workspaceId: WS });
  if (options.state === "erased") {
    const legacyRequest = buildOfficialApiSourcePacketRequest(SOURCE, [1], PROFILE).source_request;
    const legacy = requireCompletePublicBind(bindReceivedSourceInterpretationPayload({ sourceCorpus: SOURCE,
      request: legacyRequest, artifactKey: "orion-parcel-source", rawJson: JSON.stringify({ interpretations: [{ assertion_id: 1,
        relations: [{ predicate: { text: "sent" }, arguments: [{ role: "theme", phrase: { text: "parcel P" } }], qualifiers: [] }] }] }) }));
    await publishCorePublicSources({ database, bind: legacy, workspaceId: WS, runId: RUN, now: CLOCK });
    const source = stores.listRecords(WS)[0]!;
    const eraser = new SqliteFieldEraseBarrierRepo(database, fieldContractSha256);
    const barrier = { identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", source.identity, ""], fieldContractSha256),
      barrier_id: "erase-interpretation-source", workspace_id: WS, generation_id: null,
      subject_kind: "source_record" as const, subject_id: source.identity, erased_at: CLOCK };
    eraser.apply(barrier); eraser.apply(barrier);
    const remaining = database.connection.prepare("SELECT gist,excerpt,lifecycle_state FROM evidence_capsules WHERE workspace_id=?").all(WS) as { gist: string; excerpt: string | null; lifecycle_state: string }[];
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every((row) => row.gist === "erased" && row.excerpt === null && row.lifecycle_state === "tombstone")).toBe(true);
  }
  database.close(); closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    await client.ready();
    await body({ ids, reason: (request) => client.sourceInterpretationPort!.reason({ workspace_id: WS,
      as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request }) });
  } finally { await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
}

function request(packet_id: string, program = PROGRAM): SourceInterpretationReasoningRequest {
  return { contract: "source-interpretation-reasoning-v1", accepts_unreviewed_conditional_results: true,
    packet_id, profile_id: PROFILE_ID, original_query: "Which sent parcel has a recipient who promised to inspect that same parcel?",
    seed_nodes: ["sending"], program, budget: BUDGET, output_byte_limit: 1000000 };
}

it("composes same-hypothesis extracted event roles through SQLite reopen and the existing worker solver", async () => {
  const positive = packet();
  const ablated = SourceInterpretationPacketSchema.parse({ ...positive,
    propositions: positive.propositions.filter((row) => row.id !== "inspection").map((row) => row.id === "promising"
      ? { ...row, arguments: row.arguments.filter((arg) => arg.role !== "content") } : row) });
  const falseJoin = SourceInterpretationPacketSchema.parse({ ...positive,
    referents: [...positive.referents, { id: "Q", mentions: ["q3"] }],
    propositions: positive.propositions.map((row) => row.id === "inspection" ? { ...row,
      arguments: row.arguments.map((arg) => arg.role === "theme" ? { ...arg, target: "Q" } : arg) } : row) });
  const negated = SourceInterpretationPacketSchema.parse({ ...positive,
    propositions: positive.propositions.map((row) => row.id === "promising" ? { ...row,
      arguments: row.arguments.map((arg) => arg.role === "content" ? { ...arg, target: "negation" } : arg) } : row),
    operators: [{ id: "negation", operator: "not", assertion_ids: [2], operands: [{ role: "content", target: "inspection" }] }] });
  const complementary = SourceInterpretationPacketSchema.parse({ ...positive,
    propositions: positive.propositions.map((row) => row.id === "sending" ? { ...row,
      arguments: row.arguments.filter((arg) => arg.role !== "theme") } : row) });
  const distinctReferents = SourceInterpretationPacketSchema.parse({ ...positive,
    mentions: positive.mentions.map((row) => row.id === "p1" ? { ...row, source_ref: sourceRef(1, "P") } : row),
    referents: [...positive.referents.map((row) => row.id === "P" ? { ...row, mentions: ["p1"] } : row), { id: "P2", mentions: ["p2"] }],
    propositions: positive.propositions.map((row) => row.id === "inspection" ? { ...row,
      arguments: row.arguments.map((arg) => arg.role === "theme" ? { ...arg, target: "P2" } : arg) } : row) });
  await withPublishedPackets([positive, ablated, falseJoin, negated, complementary, distinctReferents, positive], async ({ ids, reason }) => {
    const result = await reason(request(ids[0]!));
    expect(result.index?.entries.map((row) => row.interpretation_node?.node_id)).toEqual(["P"]);
    expect(result.interpretation).toMatchObject({ packet_id: ids[0], hypothesis_id: ids[0], semantic_status: "unreviewed", world_claim: "unknown" });
    expect(SourceInterpretationReasoningResultSchema.safeParse({ ...result, interpretation: { ...result.interpretation,
      source_target: { ...result.interpretation.source_target, root_id: "foreign-root" } } }).success).toBe(false);
    expect(SourceInterpretationReasoningResultSchema.safeParse({ ...result, index: { ...result.index,
      entries: result.index!.entries.map((entry) => ({ ...entry, target: { ...entry.target, root_id: "foreign-root" } })) } }).success).toBe(false);
    expect(result.computation_status).toBe("complete");
    expect(result.interpretation_packet?.packet.referents.find((row) => row.id === "P")?.mentions).toEqual(["p1", "p2"]);
    const unicode = result.interpretation_packet!.mention_spans.find((row) => row.id === "unicode")!;
    expect(unicode.text).toBe("中文🙂");
    expect(Buffer.from(SOURCE).subarray(...unicode.utf8_span).toString("utf8")).toBe("中文🙂");
    expect(result.work.native_work).toBeGreaterThan(0);
    expect(result.work.native_bytes).toBeGreaterThan(0);
    expect(result.work.engine_work + result.work.projection_work + result.work.preparation_work + result.work.native_work).toBeLessThan(BUDGET.work_units - BUDGET.finalization_reserve);
    expect(() => encodeIndexResults(result.index!)).toThrow(/interpretation/u);
    expect(new Set(result.premises.map((row) => `${row.statement_id}:${row.from_node}:${row.to_node}:${row.relation_kind}`))).toEqual(new Set([
      `sending:sending:sending:${sourceInterpretationRelationKey("asserted", "send")}`,
      `sending:sending:P:${sourceInterpretationRelationKey("role", "theme")}`,
      `sending:sending:Vega:${sourceInterpretationRelationKey("role", "recipient")}`,
      `promising:Vega:promising:${sourceInterpretationRelationKey("inverse_role", "promisor")}`,
      `promising:promising:promising:${sourceInterpretationRelationKey("asserted", "promise")}`,
      `promising:promising:inspection:${sourceInterpretationRelationKey("role", "content")}`,
      `inspection:inspection:inspection:${sourceInterpretationRelationKey("predicate", "inspect")}`,
      `inspection:inspection:P:${sourceInterpretationRelationKey("role", "theme")}`
    ]));
    const empty = await reason(request(ids[1]!));
    expect(empty.index?.entries).toEqual([]);
    expect(empty.computation_status).toBe("complete");
    expect(empty.status).toBe("incomplete");
    expect(empty.index?.completeness).toMatchObject({ logical_index: "complete", observed_coverage: "exhausted_empty", interpretation_coverage: "open" });
    const limited = await reason({ ...request(ids[0]!), budget: { ...BUDGET,
      work_units: result.work.native_work + result.work.preparation_work + 50, finalization_reserve: 20 } });
    expect(limited.computation_status).toBe("incomplete");
    expect((await reason(request(ids[2]!))).index?.entries).toEqual([]);
    expect((await reason(request(ids[3]!))).index?.entries).toEqual([]);
    // The two complementary packets coexist, but neither may borrow the other's missing premise.
    expect((await reason(request(ids[4]!))).index?.entries).toEqual([]);
    expect((await reason(request(ids[5]!))).index?.entries).toEqual([]);
    const batchResult = await reason(request(ids[6]!));
    expect(batchResult.index?.entries.map((row) => row.interpretation_node?.node_id)).toEqual(["P"]);
    expect(batchResult.interpretation_packet?.provenance.transport).toMatchObject({ kind: "gemini_batch", attempt_ordinal: 1 });
    expect(batchResult.premises.map((row) => [row.statement_id, row.relation_kind, row.from_node, row.to_node])).toEqual(
      result.premises.map((row) => [row.statement_id, row.relation_kind, row.from_node, row.to_node]));
    const clipped = await reason({ ...request(ids[0]!), output_byte_limit: 1500 });
    expect(clipped.status).toBe("output_limited");
    expect(clipped.index).toBeNull();
    expect(clipped.interpretation.semantic_status).toBe("unreviewed");
    expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(1500);
    const actualInspection = await reason({ ...request(ids[0]!, rel("asserted", "inspect", "inspection", "inspection")), seed_nodes: ["inspection"] });
    expect(actualInspection.index?.entries).toEqual([]);
  });
}, 30000);


it.each([
  { valid_from: "2026-09-19T00:00:00.000Z" },
  { valid_from: "2026-09-01T00:00:00.000Z", valid_to: CLOCK }
])("does not use a source outside its governed validity interval: %j", async (validity) => {
  await withPublishedPackets([packet()], async ({ ids, reason }) => {
    expect((await reason(request(ids[0]!))).index?.entries ?? []).toEqual([]);
  }, validity);
});

it("allows ordinary co-root event references while rejecting governing content escaping as asserted", async () => {
  const base = packet();
  const connected = SourceInterpretationPacketSchema.parse({ ...base, propositions: base.propositions.map((row) =>
    row.id === "sending" ? { ...row, arguments: [...row.arguments, { role: "accompaniment", target: "promising" }] } : row) });
  await withPublishedPackets([connected], async ({ ids, reason }) => {
    const result = await reason(request(ids[0]!, seq(rel("asserted", "send", "s", "s"),
      rel("role", "accompaniment", "s", "p"), rel("asserted", "promise", "p", "p"))));
    expect(result.index?.entries.map((entry) => entry.interpretation_node?.node_id)).toEqual(["promising"]);
  });
  const escaped = SourceInterpretationPacketSchema.parse({ ...base, roots: [...base.roots, "inspection"] });
  expect(() => assertSourceInterpretationPacketProfile(escaped, PROFILE, fieldContractSha256)).toThrow(/governed/u);
});

it.each(["retired", "erased", "superseded"] as const)("refuses %s packet/source state after reopening", async (state) => {
  await withPublishedPackets([packet()], async ({ ids, reason }) => {
    await expect(reason(request(ids[0]!))).rejects.toThrow();
  }, { state });
});

it("rejects denied source scope and finite native-read budget without returning a bare conclusion", async () => {
  await withPublishedPackets([packet()], async ({ ids, reason }) => {
    await expect(reason(request(ids[0]!))).rejects.toThrow(/scope/u);
  }, { scope: "global_core" });
  await withPublishedPackets([packet()], async ({ ids, reason }) => {
    await expect(reason({ ...request(ids[0]!), budget: { ...BUDGET, memory_bytes: 100 } })).rejects.toThrow();
    const observed = await reason(request(ids[0]!));
    const directoryBudget = observed.work.packet_bytes + sourceReferencePreparationCost(ASSERTIONS).memory_bytes - 1;
    await expect(reason({ ...request(ids[0]!), budget: { ...BUDGET, memory_bytes: directoryBudget } }))
      .rejects.toThrow(/source reference preparation budget/u);
    await expect(reason(request(ids[0]!, rel("role", "unknown-role", "x", "y")))).rejects.toThrow(/unknown/u);
  });
});

it("reads a legal packet larger than the historical hint cap under an adequate budget", async () => {
  const base = packet();
  const profile = { ...PROFILE, description: "界".repeat(4096),
    predicates: PROFILE.predicates.map((row) => ({ ...row, meaning: "界".repeat(1024) })),
    roles: PROFILE.roles.map((row) => ({ ...row, meaning: "界".repeat(1024) })) };
  const profile_id = sourceInterpretationProfileIdentity(profile, fieldContractSha256);
  const large = SourceInterpretationPacketSchema.parse({ ...base, profile_id, mentions: [...base.mentions,
    ...Array.from({ length: 180 }, (_, index) => ({ id: `extra${index}`, assertion_id: 2,
      source_ref: sourceRef(2, ASSERTIONS[1]!.text) }))] });
  await withPublishedPackets([large], async ({ ids, reason }) => {
    const result = await reason({ ...request(ids[0]!), profile_id });
    expect(result.work.packet_bytes).toBeGreaterThan(65536);
    expect(result.index?.entries.map((entry) => entry.interpretation_node?.node_id)).toEqual(["P"]);
  }, { profile });
});
