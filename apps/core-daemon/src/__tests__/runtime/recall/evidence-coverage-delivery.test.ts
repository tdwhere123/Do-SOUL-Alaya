import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { createHash } from "node:crypto";
import { warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, type EvidenceCondition, type QueryInterpretationProposal } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition, runConditionalFieldRecallWithReceipt, snapshotIdFromPin, type ObserverReaders } from "@do-soul/alaya-core";
import { prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import { STATEMENT_SESSION_IDLE_MS } from "../../../garden/statement-session/statement-session-closure.js";
import { createConditionalFieldObserverReaders, nominateNativeSources } from "../../../runtime/recall-read-worker/observer-operations.js";
import { prepareRecordedStatementIndex, RECORDED_STATEMENT_CONFIGURATION } from
  "../../../../../bench-runner/src/__tests__/support/recorded-statement-index.js";
import { CONTAINER, START, WORKSPACE, createStatementSessionEnvironment, hostMessages } from "../../garden/statement-session-fixture.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { PROVIDER_FREE_WORKER_IMPORT } from "./source-semantic-index-acquisition.test-support.js";

type Environment = Awaited<ReturnType<typeof createStatementSessionEnvironment>>;
const environments: Environment[] = [];
afterEach(async () => { for (const environment of environments.splice(0)) await environment.close(); });
// Witness reads never initiate segmenter loading; the daemon worker warms it for segmented indexes.
beforeAll(async () => { expect(await warmCjkSegmentation()).toBe(true); });
const QUERY = "zzqx", ROUNDS = 7;
/** Condition one is witnessed only by round 6 (outside the first five); condition two only by round 4 (slot 5).
 * Every statement key comes from a user message; only round 6's key states its day ("today"). */
const STATEMENTS = ["The user planted bed six.", "The user planted bed four."];
const CONDITIONS: readonly EvidenceCondition[] = STATEMENTS.map(statement => ({ statement, speaker: "user", anchors: [] }));
const DEMANDS: Record<string, number[]> = { [QUERY]: [1, 0, 0, 0], [STATEMENTS[0]!]: [0, 0, 1, 0], [STATEMENTS[1]!]: [0, 0, 0, 1] };
/** The production ordinary request budget used by the frozen B0 rows. */
const PRODUCTION_BUDGET = { schema_version: 1 as const, work_units: 9984, memory_bytes: 999610,
  page_budget: 5, finalization_reserve: 100, min_envelope: 10 };

function configuration(providerKind: string) {
  return { ...RECORDED_STATEMENT_CONFIGURATION, profile: { ...RECORDED_STATEMENT_CONFIGURATION.profile,
    provider_kind: providerKind, model_id: "recorded-4-axis", dimensions: 4 } };
}

/** Rounds rank by their message vectors in round order; each round has one statement key. */
async function publishedRounds(providerKind = "local_onnx") {
  const env = await createStatementSessionEnvironment(); environments.push(env);
  const turns = Array.from({ length: ROUNDS }, (_, k) => [{ role: "user" as const, content: `Round ${k}: I planted bed ${k}.` },
    { role: "assistant" as const, content: "Noted." }]);
  // The host reports when the session happened; it is each root's recorded event time.
  await env.capture({ container: CONTAINER, messages: hostMessages(turns, 0, START) });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await env.processSession(env.provider(text => text.startsWith("Round ")
    ? [{ text: `The user planted a garden bed (${text.slice(0, 7)})${text.startsWith("Round 6") ? " today" : ""}.`, relation: "garden" }] : []));
  const roots = env.roots();
  expect(roots).toHaveLength(ROUNDS);
  const config = configuration(providerKind);
  const { generation } = prepareRecordedStatementIndex(env.database, WORKSPACE, source => {
    const round = roots.indexOf(source.target.root_id);
    if (round === -1) return [0, 1, 0, 0];
    if (source.auxiliary === undefined) return [1, 0.2 * (round + 1), 0, 0];
    return round === 6 ? [0.3, 0, 1, 0] : round === 4 ? [0.3, 0, 0, 1] : [0.5, 1, 0, 0];
  }, config);
  prepareIndexedRecallProjection(env.database);
  const prepare = (statements?: readonly string[]) => SourceIndexAcquisition.prepareQuery({ navigation: QUERY,
    ...(statements === undefined ? {} : { evidence_statements: statements }), selection: generation.selection,
    signal: new AbortController().signal, remainingMs: () => 60_000,
    bind: async () => ({ status: "ready" as const, profile: config.profile, profile_id: generation.selection.profile_id,
      embedInputs: async inputs => inputs.map(input => ({ status: "embedded" as const, input_id: input.input_id,
        input_digest: input.input_id, vector: Float32Array.from(DEMANDS[input.text]!), token_count: 1, truncated: false })) }) });
  return { env, roots, prepare };
}

const DAY = START.slice(0, 10);
const proposal = (conditions: readonly EvidenceCondition[], timed = false, derived = false): QueryInterpretationProposal => ({ schema_version: 1,
  original_query_digest: `sha256:${createHash("sha256").update(QUERY, "utf8").digest("hex")}`,
  producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID, producer_version: "1",
  ...(timed ? { question_time: { interpretation_clock: START, intervals: [{ start: DAY, end: DAY }] } } : {}),
  ...(conditions.length === 0 ? {} : { evidence_conditions: conditions, ...(derived ? { evidence_relation: "derived" as const } : {}) }) });

function request(env: Environment, readers: ObserverReaders, conditions?: readonly EvidenceCondition[], timed = false, derived = false) {
  return { workspace_id: WORKSPACE, query_text: QUERY, readers,
    snapshot_id: snapshotIdFromPin(WORKSPACE, readers.snapshotPin!(WORKSPACE)), budget: PRODUCTION_BUDGET,
    interpretation_clock: START, as_of: START, expires_at: "2099-01-01T00:00:00.000Z", authorized_scopes: ["project"],
    enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const,
    protocol_version: 1 as const, supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    supports_source_evidence: true, supports_product_updates: true,
    ...(conditions === undefined && !timed ? {} : { interpretation_proposal: proposal(conditions ?? [], timed, derived) }) };
}

/** Every delivered source root across continuation pages, through the real SQLite field. */
function sourceOrder(env: Environment, readers: ObserverReaders, conditions?: readonly EvidenceCondition[], timed = false): string[] {
  return sourceDelivery(env, readers, conditions, timed).map(row => row.root);
}

function sourceDelivery(env: Environment, readers: ObserverReaders, conditions?: readonly EvidenceCondition[], timed = false,
  derived = false): { root: string; span: readonly [number, number] | null }[] {
  const initial = request(env, readers, conditions, timed, derived), ids: { root: string; span: readonly [number, number] | null }[] = [],
    pageSizes: number[] = [];
  let continuation: ReturnType<typeof runConditionalFieldRecallWithReceipt>["index"]["continuation"] | undefined;
  for (let page = 0; page < 10 && continuation !== null; page++) {
    const result = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt(
      { ...initial, ...(continuation === undefined ? {} : { continuation }) }))();
    expect(result.index.result_version).toBe("ordinary-native-field.v14");
    const delivered = result.index.entries.flatMap(entry => entry.target.kind === "source_evidence" ? [{ root: entry.target.root_id,
      span: entry.target.span === undefined ? null : [entry.target.span.content_start, entry.target.span.content_end] as const }] : []);
    ids.push(...delivered); pageSizes.push(delivered.length);
    continuation = result.index.continuation;
  }
  expect(continuation).toBeNull();
  // The first five close the first page, so a permutation straddles the continuation boundary.
  expect(pageSizes[0]).toBe(5);
  return ids;
}

it("keeps today's order without conditions and injects a late typed witness while protecting a serving slot", async () => {
  const { env, roots, prepare } = await publishedRounds();
  const bare = await prepare(), covered = await prepare(STATEMENTS);
  expect(covered.evidence?.map(route => route.vector.status)).toEqual(["available", "available"]);
  const plain = createConditionalFieldObserverReaders(env.database, [], bare.vector);
  const baseline = sourceOrder(env, plain);
  expect(baseline).toEqual(roots);
  // Conditions without prepared vectors, or vectors without admitted conditions, leave the order byte-identical.
  expect(sourceOrder(env, plain, CONDITIONS)).toEqual(baseline);
  const prepared = createConditionalFieldObserverReaders(env.database, [], covered.vector, undefined, "allowance", covered.evidence);
  expect(sourceOrder(env, prepared)).toEqual(baseline);
  // Round 4 tops statement two at slot 5 and is protected; round 6 replaces round 3, which follows at slot 6.
  const expected = [roots[0], roots[1], roots[2], roots[6], roots[4], roots[3], roots[5]];
  expect(sourceOrder(env, prepared, CONDITIONS)).toEqual(expected);
  // Membership is unchanged: no root leaves the order.
  expect(new Set(expected)).toEqual(new Set(roots));
  // Same vectors, but no key witnesses condition one: an assistant condition, or an anchor (from the question)
  // that no key or message contains, leaves the order as is.
  expect(sourceOrder(env, prepared, [{ ...CONDITIONS[0]!, speaker: "assistant" }, CONDITIONS[1]!])).toEqual(baseline);
  expect(sourceOrder(env, prepared, [{ ...CONDITIONS[0]!, anchors: [QUERY] }, CONDITIONS[1]!])).toEqual(baseline);
  // Under a question window the window is each condition's time dimension: round 6 states its day inside it and
  // stays a necessary witness; round 4 is undated, so condition two has only possible witnesses and no top.
  const timed = sourceOrder(env, prepared, undefined, true);
  expect(timed.slice(0, 5)).not.toContain(roots[6]);
  expect(sourceOrder(env, prepared, CONDITIONS, true)).toEqual([...timed.slice(0, 4), roots[6], ...timed.slice(4).filter(root => root !== roots[6])]);
  expect(sourceOrder(env, prepared, [CONDITIONS[1]!], true)).toEqual(timed);

  const nominated = env.database.connection.transaction(() => nominateNativeSources(env.database,
    { workspaceId: WORKSPACE, query: QUERY, authorizedScopes: ["project"], budget: { work_units: 0, memory_bytes: 0 },
      evidenceConditions: CONDITIONS }, covered.vector, undefined, "allowance", covered.evidence))();
  expect(nominated.association).toMatchObject({ statements: 2, decision: { refused: null, applied: false } });
  expect(nominated.association!.roots).toHaveLength(ROUNDS);
  expect(nominated.result?.resource_refusals).toEqual([]);
  // Request-funded library acquisition carries no association quote and never computes coverage.
  expect(env.database.connection.transaction(() => nominateNativeSources(env.database,
    { workspaceId: WORKSPACE, query: QUERY, authorizedScopes: ["project"], budget: { work_units: 10_000_000, memory_bytes: 64_000_000 },
      evidenceConditions: CONDITIONS }, covered.vector, undefined, "request", covered.evidence))().association).toBeUndefined();
});

it("delivers another instance of a placed condition as its witness message under a derived relation", async () => {
  const { env, roots, prepare } = await publishedRounds();
  const covered = await prepare(STATEMENTS);
  const readers = createConditionalFieldObserverReaders(env.database, [], covered.vector, undefined, "allowance", covered.evidence);
  const plain = sourceDelivery(env, readers, CONDITIONS), derived = sourceDelivery(env, readers, CONDITIONS, false, true);
  // Condition two's top (round 4) is in the first five; its next witnesses are rounds 0-3, and only round 3 is outside.
  expect(derived.map(row => row.root)).toEqual(plain.map(row => row.root));
  expect(derived.filter(row => row.root !== roots[3])).toEqual(plain.filter(row => row.root !== roots[3]));
  const before = plain.find(row => row.root === roots[3])!.span!, variant = derived.find(row => row.root === roots[3])!.span!;
  expect(before[0]).toBe(0);
  // Exactly round 3's user message: the statement key's host span, not the root's prefix.
  const body = env.database.connection.prepare("select source_body from source_records where record_id=?").get(roots[3]) as { source_body: string };
  const text = Buffer.from(body.source_body, "utf8").subarray(variant[0], variant[1]).toString("utf8");
  expect(variant[0]).toBeGreaterThan(0);
  expect(text).toContain("Round 3: I planted bed 3.");
  expect(text).not.toContain("Noted.");
});

it("never embeds condition statements through a non-local provider and keeps the base order", async () => {
  const { env, roots, prepare } = await publishedRounds("recorded-fixture");
  const covered = await prepare(STATEMENTS);
  expect(covered.vector.status).toBe("available");
  expect(covered.evidence?.map(route => route.vector)).toEqual(Array(2).fill(
    { status: "unavailable", reason: "evidence_statement_requires_local_inference" }));
  expect(covered.evidence?.every(route => route.receipt.submitted_inputs === 0)).toBe(true);
  const readers = createConditionalFieldObserverReaders(env.database, [], covered.vector, undefined, "allowance", covered.evidence);
  expect(sourceOrder(env, readers, CONDITIONS)).toEqual(roots);
});

it("delivers the same permutation through the built worker under the production grant", async () => {
  assertBuiltWorker();
  const { env, roots, prepare } = await publishedRounds();
  const covered = await prepare(STATEMENTS);
  const readers = createConditionalFieldObserverReaders(env.database, [], covered.vector, undefined, "allowance", covered.evidence);
  const expected = sourceOrder(env, readers, CONDITIONS);
  expect(expected).toEqual([roots[0], roots[1], roots[2], roots[6], roots[4], roots[3], roots[5]]);

  process.execArgv.push(PROVIDER_FREE_WORKER_IMPORT);
  let client;
  try { client = createRecallReadWorkerClient({ databaseFilename: env.filename, workerUrl: builtWorkerUrl, workerCount: 1 })!; }
  finally { process.execArgv.splice(process.execArgv.lastIndexOf(PROVIDER_FREE_WORKER_IMPORT), 1); }
  try {
    await client.ready();
    const { readers: _readers, ...base } = request(env, readers, CONDITIONS);
    const initial = { ...base, prepared_query: covered };
    const observed = await client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288, capture_page_attempts: true },
      () => client!.conditionalFieldPort.recall(initial));
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const facts = observed.observations.flatMap(frame => frame.events);
    expect(facts.find(event => event.kind === "source_index_acquisition" && (event.data as { kind: string }).kind === "acquisition_complete")?.data)
      .toMatchObject({ statement_association: { status: "ready", roots: ROUNDS, keys: ROUNDS, statements: 2 } });
    // Only per-root coverage crosses into the field; it fits the production field grant.
    expect(facts.filter(event => event.kind === "statement_association_retention").map(event => event.data)).toEqual([
      expect.objectContaining({ stage: "source_retention", status: "retained" }),
      expect.objectContaining({ stage: "field_admission", status: "retained" })
    ]);
    expect(facts.find(event => event.kind === "field_access_order")?.data).toMatchObject({ evidence_coverage: {
      status: "permuted", statements: 2, top_source_positions: [7, 5],
      injections: [{ statement: 0, root_position: 7, status: "injected", slot: 4 }], reason: null } });
    const delivered: string[] = [];
    let page = observed.outcome.value, pageCount = 0;
    while (true) {
      delivered.push(...page.index.entries.flatMap(entry => entry.target.kind === "source_evidence" ? [entry.target.root_id] : []));
      pageCount++;
      if (page.index.continuation === null) break;
      if (page.preparation_id === undefined) throw new Error("worker delivery preparation required");
      await client.conditionalFieldPort.acknowledge!(page.preparation_id, page.index, new Map(Object.entries(page.previews)));
      page = await client.conditionalFieldPort.recall({ ...initial, continuation: page.index.continuation });
      expect(pageCount).toBeLessThan(10);
    }
    expect(pageCount).toBeGreaterThan(1);
    expect(delivered).toEqual(expected);

    // A field grant that fits base nominations but not the optional coverage discards it before admission
    // instead of failing acquisition.
    // Field memory is a non-linear share of the request grant, so search the request grant.
    const admissionOf = (frames: readonly { events: readonly { kind: string; data: unknown }[] }[]) => frames.flatMap(frame => frame.events)
      .find(event => event.kind === "statement_association_retention" && (event.data as { stage: string }).stage === "field_admission")
      ?.data as { required_bytes: number; available_bytes: number; retained_bytes: number } | undefined;
    const admitted = admissionOf(observed.observations)!;
    expect(admitted).toMatchObject({ available_bytes: 933818 });
    expect(admitted.retained_bytes).toBeGreaterThan(0);
    const baseBytes = admitted.required_bytes - admitted.retained_bytes;
    let low = 0, high = initial.budget.memory_bytes, limited: Awaited<ReturnType<typeof client.observeSourceSemantics>> | undefined;
    for (let attempt = 0; attempt < 32 && limited === undefined && high - low > 1; attempt++) {
      const memory = Math.floor((low + high) / 2);
      const probe = await client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288 },
        () => client!.conditionalFieldPort.recall({ ...initial, budget: { ...initial.budget, memory_bytes: memory } }));
      const fact = probe.outcome.status === "success" ? admissionOf(probe.observations) : undefined;
      if (fact === undefined || fact.available_bytes < baseBytes) low = memory;
      else if (fact.available_bytes >= admitted.required_bytes) high = memory;
      else limited = probe;
    }
    if (limited === undefined) throw new Error("no field grant between base and base plus coverage");
    if (limited.outcome.status !== "success") throw limited.outcome.error;
    const limitedFacts = limited.observations.flatMap(frame => frame.events);
    expect(limitedFacts.filter(event => event.kind === "statement_association_retention").map(event => event.data))
      .toContainEqual(expect.objectContaining({ stage: "field_admission", status: "discarded",
        reason: "field_retained_statement_association", retained_bytes: 0 }));
    // Such a grant leaves no room to navigate: the page is empty rather than ordered without coverage.
    expect(limitedFacts.some(event => event.kind === "field_access_order")).toBe(false);
  } finally { await client.close(); }
}, 60_000);
