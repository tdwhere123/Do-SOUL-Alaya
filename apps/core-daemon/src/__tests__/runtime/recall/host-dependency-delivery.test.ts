import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import {
  HostSessionMessageSchema, hashLabeledIdentity, hashSourceRecordId, hashContentDigest, hostSessionRoundSource, indexEntryCacheKey, sourceIndexTarget,
  type HostSessionMessage, type HostSourceDependency, type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import { encodeIndexResults, fieldContractSha256, snapshotIdFromPin, runConditionalFieldRecallWithReceipt,
  captureIndexPreviews } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository, prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { CONTAINER, CONTAINER_KEY, START, WORKSPACE, createStatementSessionEnvironment, hostMessages } from "../../garden/statement-session-fixture.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { PROVIDER_FREE_WORKER_IMPORT } from "./source-semantic-index-acquisition.test-support.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const env of environments.splice(0)) await env.close(); });
const BUDGET = { work_units: 2_000_000, memory_bytes: 16_000_000 };
async function environment() {
  const env = await createStatementSessionEnvironment(); environments.push(env); return env;
}
const turn = (content: string, start: number, dependencies?: readonly HostSourceDependency[]) =>
  hostMessages([[{ role: "user", content }, { role: "assistant", content: "Noted." }]], start)
    .map(message => ({ ...message, ...(dependencies === undefined ? {} : { semantic_dependencies: dependencies }) }));

function target(env: Environment, rootId: string): SourceEvidenceTarget {
  const row = new SqliteFieldSourceRecordRepo(env.database, fieldContractSha256).findById(WORKSPACE, rootId)!;
  return { kind: "source_evidence", workspace_id: WORKSPACE, root_kind: "source_record", root_id: row.record_id,
    source_version: row.source_version, content_digest: row.content_digest, evidence_object_id: row.evidence_object_id };
}
function read(env: Environment, source: SourceEvidenceTarget, scopes: readonly string[] | null = ["project"], budget = BUDGET) {
  return createConditionalFieldObserverReaders(env.database).sourceDependencies!({ target: source,
    span: [0, 100_000], authorizedScopes: scopes, budget });
}

it("persists explicit empty and bound cross-round references, returns reusable identities and rejects changed replay", async () => {
  const env = await environment();
  const first = await env.capture({ container: CONTAINER, messages: turn("seed context", 0, []) });
  const reference = first.message_sources![0]!.source;
  expect(reference).toMatchObject({ source_id: first.message_sources![1]!.source.source_id,
    occurrence_id: "message-0", root_id: env.roots()[0], source_version: "host-session-v1" });
  const messages = turn("needle dependent source", 2, [reference]);
  const captured = await env.capture({ container: CONTAINER, messages });
  const source = target(env, captured.message_sources![0]!.source.root_id);
  const result = read(env, source);
  expect(result.exposure.status).toBe("complete");
  expect(result.exposure.roots.map(row => row.dependencies)).toEqual([[reference], [reference]]);
  expect(result.exposure.prerequisites).toEqual([{ reference, status: "delivered", content: "seed context",
    utf8_span: [6, 18], content_span: [6, 18], dependencies: [] }]);
  expect(result.resources.work).toBeGreaterThan(0);
  expect(result.resources.native_bytes).toBeGreaterThan(0);
  expect(result.resources.memory_bytes).toBeGreaterThan(result.resources.native_bytes);
  expect(env.database.connection.prepare(`SELECT semantic_dependencies_json, semantic_dependencies_digest
    FROM host_session_messages WHERE message_id='message-2'`).get()).toMatchObject({
    semantic_dependencies_json: null, semantic_dependencies_digest: expect.stringMatching(/^sha256:/) });
  await expect(env.capture({ container: CONTAINER, messages: messages.map(message => ({ ...message, semantic_dependencies: [] })) }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await env.capture({ container: CONTAINER, messages })).toMatchObject({ replayed_message_count: 2,
    message_sources: captured.message_sources });
  const reopened = env.reopen();
  const persisted = new SqliteSourceIndexRepository(reopened, fieldContractSha256).readHostDependency(WORKSPACE, reference,
    reference.occurrence_id, BUDGET, () => "admitted");
  expect(persisted).toMatchObject({ status: "ready", text: "seed context", occurrence: { semantic_dependencies: [] } });
});

it("keeps historical absence unknown and rejects workspace redirection and excerpt assertions", async () => {
  const env = await environment();
  await env.capture({ container: CONTAINER, messages: turn("historical independent source", 0) });
  expect(read(env, target(env, env.roots()[0]!)).exposure).toMatchObject({ status: "unknown", prerequisites: [] });
  const message: HostSessionMessage = { ...turn("new", 2)[0]!, semantic_dependencies: [] };
  expect(HostSessionMessageSchema.safeParse({ ...message, semantic_dependencies: [{ source_id: "s", root_id: "r",
    source_version: "1", content_digest: `sha256:${"a".repeat(64)}`, occurrence_id: "m", workspace_id: "other" }] }).success).toBe(false);
  expect(() => env.sourceAdmission.admit({ workspace_id: WORKSPACE, source_id: "excerpt", source_version: "1",
    content_bytes: "body", evidence_object_id: null, recorded_at: START, event_time: null, valid_from: null, valid_to: null,
    scope_class: "project", spans: [], host_occurrences: [{ occurrence_id: "m", utf8_span: [0, 4], role: "user",
      channel: null, author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null,
      completeness: "excerpt", fidelity: "unknown", semantic_dependencies: [] }] }, { workspaceId: WORKSPACE,
    hostCapture: () => ({ namespace: "test", workspace_id: WORKSPACE, producer: "test", basis: "reported_excerpt" }) }))
    .toThrow(/semantic dependencies/);
});

it("refuses oversized pending metadata before persistence and leaves the same message identity capturable", async () => {
  const env = await environment();
  const reference = { source_id: "s".repeat(256), root_id: "r".repeat(256), source_version: "v".repeat(256),
    occurrence_id: "m".repeat(256), content_digest: `sha256:${"a".repeat(64)}` };
  const message = { ...turn("pending", 0)[0]!, semantic_dependencies: Array(32).fill(reference) };
  await expect(env.capture({ container: CONTAINER, messages: [message] })).rejects.toThrow(/metadata cannot fit/);
  expect(env.database.connection.prepare("SELECT COUNT(*) AS n FROM host_session_messages").get()).toEqual({ n: 0 });
  expect(await env.capture({ container: CONTAINER, messages: [{ ...message, semantic_dependencies: [] }] }))
    .toMatchObject({ admitted_message_count: 1, pending_message_count: 1 });
});

it("bounds explicit cycles and refuses stale, missing and cross-workspace target bindings", async () => {
  const env = await environment(), messages = turn("cycle", 0, []);
  const rendered = hostSessionRoundSource(CONTAINER, CONTAINER_KEY, 0, messages);
  const digest = hashContentDigest(rendered.content, fieldContractSha256);
  const reference = { source_id: rendered.source_id, source_version: rendered.source_version, content_digest: digest,
    root_id: hashSourceRecordId({ source_id: rendered.source_id, source_version: rendered.source_version, content_digest: digest }, fieldContractSha256),
    occurrence_id: messages[0]!.message_id };
  await env.capture({ container: CONTAINER, messages: messages.map(message => ({ ...message, semantic_dependencies: [reference] })) });
  const cycle = read(env, target(env, reference.root_id));
  expect(cycle.exposure.status).toBe("partial");
  expect(cycle.exposure.prerequisites.some(row => row.status === "cycle")).toBe(true);
  expect(cycle.exposure.prerequisites.length).toBeLessThanOrEqual(3);
  expect(cycle.resources.work).toBeLessThan(BUDGET.work_units);
  const repository = new SqliteSourceIndexRepository(env.database, fieldContractSha256);
  expect(repository.readHostDependency("other-workspace", reference, reference.occurrence_id, BUDGET, () => "admitted"))
    .toMatchObject({ status: "unavailable" });
  expect(repository.readHostDependency(WORKSPACE, { ...reference, source_version: "wrong" }, reference.occurrence_id, BUDGET, () => "admitted"))
    .toMatchObject({ status: "unavailable" });
  expect(repository.readHostDependency(WORKSPACE, { ...reference, root_id: "missing" }, reference.occurrence_id, BUDGET, () => "admitted"))
    .toMatchObject({ status: "unavailable" });
  env.sourceAdmission.admit({ workspace_id: WORKSPACE, source_id: rendered.source_id, source_version: "new-version",
    content_bytes: "replacement", evidence_object_id: null, recorded_at: "2026-09-15T00:00:00Z", event_time: null,
    valid_from: null, valid_to: null, scope_class: "project", spans: [] }, { workspaceId: WORKSPACE });
  expect(repository.readHostDependency(WORKSPACE, reference, reference.occurrence_id, BUDGET, () => "admitted"))
    .toMatchObject({ status: "unavailable" });
});

it("checks scope before prerequisite bytes and preserves ordinary source after target erase, supersession or missing referent", async () => {
  const env = await environment();
  const admitted = env.sourceAdmission.admit({ workspace_id: WORKSPACE, source_id: "protected", source_version: "1",
    content_bytes: "protected prerequisite", evidence_object_id: null, recorded_at: START, event_time: null,
    valid_from: null, valid_to: null, scope_class: "global_core", spans: [], host_occurrences: [{ occurrence_id: "private",
      utf8_span: [0, 22], role: "user", channel: null, author_ref: null, container_ref: null, upstream_message_ref: null,
      upstream_position: null, completeness: "complete", fidelity: "original_bytes", semantic_dependencies: [] }] }, {
    workspaceId: WORKSPACE, hostCapture: () => ({ namespace: "test", workspace_id: WORKSPACE, producer: "test", basis: "pinned_dataset" }) });
  const reference = { source_id: "protected", root_id: admitted.record.identity, source_version: "1",
    content_digest: admitted.record.content_digest, occurrence_id: "private" };
  await env.capture({ container: CONTAINER, messages: turn("ordinary needle", 0, [reference]) });
  const source = target(env, env.roots()[0]!);
  const denied = read(env, source);
  expect(denied.exposure).toMatchObject({ status: "partial", prerequisites: [{ status: "denied" }] });
  expect(JSON.stringify(denied.exposure)).not.toContain("protected prerequisite");
  const nativeReader = new SqliteFieldSourceRecordRepo(env.database, fieldContractSha256);
  const bodyRead = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findByIdBounded");
  read(env, source);
  expect(bodyRead).not.toHaveBeenCalled(); bodyRead.mockRestore();
  env.field.fieldRepos.erase.apply({ identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", reference.root_id, ""], fieldContractSha256),
    barrier_id: "erase-dependency", workspace_id: WORKSPACE, generation_id: null, subject_kind: "source_record",
    subject_id: reference.root_id, erased_at: env.now() });
  expect(read(env, source, null).exposure).toMatchObject({ status: "partial", prerequisites: [{ status: "unavailable" }] });
  expect(nativeReader.findById(WORKSPACE, source.root_id)?.source_body).toContain("ordinary needle");
  expect(read(env, source, ["project"], { work_units: 0, memory_bytes: 0 })).toMatchObject({
    exposure: { status: "partial" }, resources: { work: 0, native_bytes: 0, memory_bytes: 0 } });
});

it("delivers dependencies through the built worker and limits encoded exposure without removing ordinary source bytes", async () => {
  assertBuiltWorker();
  const env = await environment();
  const first = await env.capture({ container: CONTAINER, messages: turn("context ".repeat(800), 0, []) });
  const reference = first.message_sources![0]!.source;
  await env.capture({ container: CONTAINER, messages: turn("needle ordinary source", 2, [reference]) });
  const records = new SqliteFieldSourceRecordRepo(env.database, fieldContractSha256);
  const repository = new SqliteSourceIndexRepository(env.database, fieldContractSha256);
  for (const row of records.listByWorkspace(WORKSPACE)) {
    const native = sourceIndexTarget(target(env, row.record_id), row.source_id, Buffer.byteLength(row.source_body!));
    expect(repository.writeLexical(native, row.source_body!, { work: 100_000, native_bytes: 1_000_000 }).status).toBe("accepted");
  }
  prepareIndexedRecallProjection(env.database);
  process.execArgv.push(PROVIDER_FREE_WORKER_IMPORT);
  let client;
  try { client = createRecallReadWorkerClient({ databaseFilename: env.filename, workerUrl: builtWorkerUrl, workerCount: 1 })!; }
  finally { process.execArgv.splice(process.execArgv.lastIndexOf(PROVIDER_FREE_WORKER_IMPORT), 1); }
  try {
    await client.ready();
    const readers = createConditionalFieldObserverReaders(env.database);
    const request = { workspace_id: WORKSPACE, query_text: "needle", source_id: `host-session:${first.container_key}:r1`,
      budget: { schema_version: 1 as const, ...BUDGET, page_budget: 1, finalization_reserve: 1_000_000, min_envelope: 10 },
      snapshot_id: snapshotIdFromPin(WORKSPACE, readers.snapshotPin!(WORKSPACE)), interpretation_clock: START,
      as_of: START, expires_at: "2099-01-01T00:00:00.000Z", authorized_scopes: ["project"],
      enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const, protocol_version: 1 as const,
      supported_result_kinds: ["memory_entry", "source_evidence"] as const, supports_source_evidence: true, supports_product_updates: true,
      delivery_budget: { max_total_tokens: 1000, max_encoded_bytes: 1_000_000 } };
    const ordinary = runConditionalFieldRecallWithReceipt({ ...request,
      delivery_context: `sha256:${fieldContractSha256("ordinary-memory")}`, readers: { ...readers, sourceDependencies: undefined } });
    let optionalReads = 0;
    const pressured = runConditionalFieldRecallWithReceipt({ ...request,
      delivery_context: `sha256:${fieldContractSha256("dependency-memory")}`, readers: { ...readers, sourceDependencies: input => {
        optionalReads++;
        // A bounded reader may legitimately consume its entire offered logical allocation.
        return { exposure: { status: "partial", roots: [], prerequisites: [] }, resources: {
          work: 1, native_bytes: 0, memory_bytes: input.budget.memory_bytes, sql_internal_work: "unknown" } };
      } } });
    expect(optionalReads).toBeGreaterThan(0);
    expect(pressured.index.entries).toEqual(ordinary.index.entries);
    expect([...captureIndexPreviews(pressured.index, {}, WORKSPACE)]).toEqual([...captureIndexPreviews(ordinary.index, {}, WORKSPACE)]);
    const page = await client.conditionalFieldPort.recall(request);
    expect(page.index.entries).toHaveLength(1);
    const previews = new Map(Object.entries(page.previews)), metadata = page.source_metadata ?? {};
    const full = encodeIndexResults(page.index, previews, 100_000, metadata);
    expect(full[0]?.semantic_dependencies?.status).toBe("partial");
    const fitted = encodeIndexResults(page.index, previews, 1000, metadata);
    expect(fitted[0]?.content_preview).toBe(full[0]?.content_preview);
    expect(fitted[0]?.semantic_dependencies?.status).toBe("partial");
    expect(fitted[0]?.semantic_dependencies?.prerequisites.some(row => row.content !== undefined)).toBe(false);
    expect(page.previews[indexEntryCacheKey(page.index.entries[0]!)]).toContain("needle ordinary source");
    expect(page.execution_receipt?.actual?.phases.payload.native_bytes).toBeGreaterThan(0);
    await client.conditionalFieldPort.acknowledge!(page.preparation_id!, page.index, previews);
    const continuation = page.index.continuation!;
    expect(continuation).not.toBeNull();
    const origin = page.index.entries[0]!.target;
    const expansion = { ...request, continuation, delivery_budget: { max_total_tokens: 100_000, max_encoded_bytes: 1_000_000 },
      payload_continuation: { schema_version: 1 as const, purpose: "payload_expansion" as const, target: origin, byte_budget: 128,
        dependency: { reference, source_occurrence_id: "message-2", start_offset: 0 } } };
    const continued = await client.conditionalFieldPort.recall(expansion);
    const continuedRows = encodeIndexResults(continued.index, new Map(Object.entries(continued.previews)), 100_000, continued.source_metadata);
    const prerequisite = continuedRows[0]!.semantic_dependencies!.prerequisites[0]!;
    expect(prerequisite).toMatchObject({ reference, status: "partial", content: "context ".repeat(16), content_span: [6, 134], next_offset: 134 });
    await client.conditionalFieldPort.acknowledge!(continued.preparation_id!, continued.index, new Map(Object.entries(continued.previews)));
    const next = await client.conditionalFieldPort.recall({ ...expansion, payload_continuation: { ...expansion.payload_continuation,
      dependency: { ...expansion.payload_continuation.dependency, start_offset: prerequisite.next_offset! } } });
    const nextRows = encodeIndexResults(next.index, new Map(Object.entries(next.previews)), 100_000, next.source_metadata);
    expect(nextRows[0]?.semantic_dependencies?.prerequisites[0]).toMatchObject({ content_span: [134, 262], next_offset: 262 });
    const forged = await client.conditionalFieldPort.recall({ ...expansion, payload_continuation: { ...expansion.payload_continuation,
      dependency: { ...expansion.payload_continuation.dependency, reference: { ...reference, occurrence_id: "unrecorded" } } } });
    const forgedRows = encodeIndexResults(forged.index, new Map(Object.entries(forged.previews)), 100_000, forged.source_metadata);
    expect(forgedRows[0]?.semantic_dependencies?.prerequisites.some(row => row.content !== undefined)).toBe(false);
    env.field.fieldRepos.erase.apply({ identity: hashLabeledIdentity("erase_barrier", [WORKSPACE, "source_record", reference.root_id, ""], fieldContractSha256),
      barrier_id: "erase-before-delivery", workspace_id: WORKSPACE, generation_id: null, subject_kind: "source_record",
      subject_id: reference.root_id, erased_at: env.now() });
    await expect(client.conditionalFieldPort.acknowledge!(next.preparation_id!, next.index, new Map(Object.entries(next.previews))))
      .rejects.toThrow(/changed|stale|invalidated/);
    expect(records.findById(WORKSPACE, origin.kind === "source_evidence" ? origin.root_id : "")?.source_body).toContain("needle ordinary source");
  } finally { await client.close(); }
}, 30_000);
