import { afterEach, expect, it, vi } from "vitest";
import { SourceSemanticResourceLedger, sourceIndexProfileId } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition, fieldContractSha256, runConditionalFieldRecallWithReceipt, snapshotIdFromPin,
  type ObserverReaders } from "@do-soul/alaya-core";
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
const QUERY = "zzqx", ROUNDS = 7;
const vector = { status: "available" as const, profile: RECORDED_STATEMENT_CONFIGURATION.profile,
  profile_id: sourceIndexProfileId(RECORDED_STATEMENT_CONFIGURATION.profile, fieldContractSha256),
  input_digest: `sha256:${fieldContractSha256(QUERY)}`, embedding: new Float32Array([1, 0, 0]) };

/** Rounds rank by their message vectors; round 4's statement key is weaker than round 5's on question
 * similarity and on link to rounds 0–3, so round 5 dominates source slot 5. */
async function publishedRounds() {
  const env = await createStatementSessionEnvironment(); environments.push(env);
  const turns = Array.from({ length: ROUNDS }, (_, k) => [{ role: "user" as const, content: `Round ${k}: I planted bed ${k}.` },
    { role: "assistant" as const, content: "Noted." }]);
  await env.capture({ container: CONTAINER, messages: hostMessages(turns) });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await env.processSession(env.provider(text => text.startsWith("Round ")
    ? [{ text: `The user planted a garden bed (${text.slice(0, 7)}).`, relation: "garden" }] : []));
  const roots = env.roots();
  expect(roots).toHaveLength(ROUNDS);
  prepareRecordedStatementIndex(env.database, WORKSPACE, source => {
    const round = roots.indexOf(source.target.root_id);
    if (round === -1) return [0, 0, 1];
    if (source.auxiliary === undefined) return [1, 0.2 * (round + 1), 0];
    return round === 4 ? [0.4, 0, 1] : [0.5, 0, 1];
  });
  prepareIndexedRecallProjection(env.database);
  return { env, roots };
}

function sourceOrder(env: Environment, readers: ObserverReaders): string[] {
  const request = { workspace_id: WORKSPACE, query_text: QUERY, readers,
    snapshot_id: snapshotIdFromPin(WORKSPACE, readers.snapshotPin!(WORKSPACE)),
    budget: { schema_version: 1 as const, work_units: 1_000_000, memory_bytes: 16_000_000,
      page_budget: 5, finalization_reserve: 512, min_envelope: 10 },
    interpretation_clock: START, as_of: START, expires_at: "2099-01-01T00:00:00.000Z", authorized_scopes: ["project"],
    enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const,
    protocol_version: 1 as const, supported_result_kinds: ["memory_entry", "source_evidence"] as const,
    supports_source_evidence: true, supports_product_updates: true };
  const ids: string[] = [], pageSizes: number[] = [];
  let continuation: ReturnType<typeof runConditionalFieldRecallWithReceipt>["index"]["continuation"] | undefined;
  for (let page = 0; page < 10 && continuation !== null; page++) {
    const result = env.database.connection.transaction(() => runConditionalFieldRecallWithReceipt(
      { ...request, ...(continuation === undefined ? {} : { continuation }) }))();
    expect(result.index.result_version).toBe("ordinary-native-field.v9");
    const page = result.index.entries.flatMap(entry => entry.target.kind === "source_evidence" ? [entry.target.root_id] : []);
    ids.push(...page); pageSizes.push(page.length);
    continuation = result.index.continuation;
  }
  expect(continuation).toBeNull();
  // Slot 5 closes the first page, so the swapped pair straddles the continuation boundary.
  expect(pageSizes[0]).toBe(5);
  return ids;
}

it("swaps a dominated source slot 5 from published statement keys through SQLite across the first page boundary", async () => {
  const { env, roots } = await publishedRounds();
  const nominate = (funding: "allowance" | "request") => env.database.connection.transaction(() => nominateNativeSources(env.database,
    { workspaceId: WORKSPACE, query: QUERY, authorizedScopes: ["project"], budget: { work_units: 10_000_000, memory_bytes: 64_000_000 } },
    vector, undefined, funding))();
  const allowance = nominate("allowance");
  expect(allowance.association?.roots.length).toBe(allowance.result?.nominations.length);
  expect(allowance.association?.question.every(value => value > -1)).toBe(true);
  expect(allowance.result?.resource_refusals).toEqual([]);
  // Request-funded pages carry no association quote, so they never pay for or apply the swap.
  expect(nominate("request").association).toBeUndefined();

  const readers = createConditionalFieldObserverReaders(env.database, [], vector);
  const withoutAssociation: ObserverReaders = { ...readers, nominateSources: input => {
    const { association: _dropped, ...nomination } = readers.nominateSources!(input);
    return nomination;
  } };
  const baseline = sourceOrder(env, withoutAssociation);
  expect(baseline.slice(0, ROUNDS)).toEqual(roots);
  const swapped = [...baseline];
  [swapped[4], swapped[5]] = [swapped[5]!, swapped[4]!];
  expect(sourceOrder(env, readers)).toEqual(swapped);
});

it("drops unfundable optional vectors while preserving actual SQLite nominations and charging spent work", async () => {
  const env = await createStatementSessionEnvironment(); environments.push(env);
  await env.capture({ container: CONTAINER, messages: hostMessages(Array.from({ length: 2 }, (_, k) => [
    { role: "user" as const, content: `Round ${k}: I planted bed ${k}.` },
    { role: "assistant" as const, content: "Noted." }])) });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await env.processSession(env.provider(text => text.startsWith("Round ")
    ? [{ text: `Garden statement for ${text.slice(0, 8)}.`, relation: "garden" }] : []));
  const configuration = { ...RECORDED_STATEMENT_CONFIGURATION,
    profile: { ...RECORDED_STATEMENT_CONFIGURATION.profile, dimensions: 4 } };
  prepareRecordedStatementIndex(env.database, WORKSPACE, source => source.auxiliary === undefined ? [1, 1, 0, 0] : [1, 0, 0, 0], configuration);
  const query = { ...vector, profile: configuration.profile,
    profile_id: sourceIndexProfileId(configuration.profile, fieldContractSha256), embedding: Float32Array.of(1, 0, 0, 0) };
  const nominate = () => env.database.connection.transaction(() => nominateNativeSources(env.database,
    { workspaceId: WORKSPACE, query: QUERY, authorizedScopes: ["project"], budget: { work_units: 0, memory_bytes: 0 } }, query))();
  const baseline = nominate(), deferred = baseline.association!;
  expect(deferred.roots).toHaveLength(2);
  expect(deferred.link).toEqual([[], [null]]);
  expect(baseline.association_retained_bytes).toBeGreaterThan(0);
  const baseFundableBytes = baseline.result!.resources.memory_bytes - baseline.association_retained_bytes!;
  const quote = SourceIndexAcquisition.quoteAllowanceBudget;
  const spy = vi.spyOn(SourceIndexAcquisition, "quoteAllowanceBudget").mockImplementation((input, capacity) => ({
    ...quote(input, capacity), memory_bytes: baseFundableBytes }));
  try {
    const tight = nominate();
    expect(tight.result?.resource_refusals).toEqual([{ stage: "admission", phase: "source retained statement association" }]);
    expect(tight.result?.nominations).toEqual(baseline.result?.nominations);
    expect(tight.association).toBeUndefined();
    expect(tight.association_retained_bytes).toBe(0);
    expect(tight.result!.resources.memory_bytes).toBeLessThanOrEqual(baseFundableBytes);
    expect(tight.result!.resources.work).toBeGreaterThan(0);
  } finally { spy.mockRestore(); }
});

it("delivers the same slot swap and continuation through the built worker with multi-key SQLite roots", async () => {
  assertBuiltWorker();
  const env = await createStatementSessionEnvironment(); environments.push(env);
  const count = 16, dimensions = 64;
  const turns = Array.from({ length: count }, (_, k) => [{ role: "user" as const, content: `Round ${k}: I planted bed ${k}.` },
    { role: "assistant" as const, content: "Noted." }]);
  await env.capture({ container: CONTAINER, messages: hostMessages(turns) });
  env.advance(STATEMENT_SESSION_IDLE_MS);
  await env.processSession(env.provider(text => text.startsWith("Round ")
    ? Array.from({ length: 4 }, (_, k) => ({ text: `Garden statement ${k} for ${text.slice(0, 8)}.`, relation: "garden" })) : []));
  const roots = env.roots(); expect(roots).toHaveLength(count);
  const configuration = { ...RECORDED_STATEMENT_CONFIGURATION, profile: { ...RECORDED_STATEMENT_CONFIGURATION.profile,
    model_id: "recorded-64-axis", dimensions } };
  const seen = new Map<string, number>();
  const { generation } = prepareRecordedStatementIndex(env.database, WORKSPACE, source => {
    const round = roots.indexOf(source.target.root_id), values = Array<number>(dimensions).fill(0);
    if (round === -1) { values[2] = 1; return values; }
    if (source.auxiliary === undefined) { values[0] = 1; values[1] = 0.2 * (round + 1); return values; }
    const key = seen.get(source.target.root_id) ?? 0; seen.set(source.target.root_id, key + 1);
    values[0] = round === 4 ? 0.4 : 0.5; values[2] = 1; values[3 + key] = 0.01;
    return values;
  }, configuration);
  expect([...seen.values()]).toEqual(Array<number>(count).fill(4));
  prepareIndexedRecallProjection(env.database);
  const queryEmbedding = new Float32Array(dimensions); queryEmbedding[0] = 1;
  const prepared = await SourceIndexAcquisition.prepareQuery({ navigation: QUERY, selection: generation.selection,
    signal: new AbortController().signal, remainingMs: () => 60_000,
    bind: async () => ({ status: "ready" as const, profile: configuration.profile, profile_id: generation.selection.profile_id,
      embedInputs: async inputs => inputs.map(input => ({ status: "embedded" as const, input_id: input.input_id,
        input_digest: input.input_id, vector: queryEmbedding, token_count: 1, truncated: false })) }) });
  if (prepared.vector.status !== "available") throw new Error(JSON.stringify(prepared));
  let pairWork = 0;
  const charge = SourceSemanticResourceLedger.prototype.charge;
  const spy = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
    if (phase === "statement key association link") pairWork += work;
    return charge.call(this, work, bytes, phase);
  });
  let nominated: ReturnType<typeof nominateNativeSources>;
  try {
    nominated = env.database.connection.transaction(() => nominateNativeSources(env.database,
      { workspaceId: WORKSPACE, query: QUERY, authorizedScopes: ["project"], budget: { work_units: 1_000_000, memory_bytes: 16_000_000 } },
      prepared.vector))();
  } finally { spy.mockRestore(); }
  expect(pairWork).toBe(0);
  expect(nominated.association?.link.flat().every(value => value === null)).toBe(true);
  expect(nominated.result?.resource_refusals).toEqual([]);
  expect(nominated.result?.nominations).toHaveLength(count);
  expect(nominated.association?.roots).toHaveLength(count);
  const readers = createConditionalFieldObserverReaders(env.database, [], prepared.vector);
  const without: ObserverReaders = { ...readers, nominateSources: input => {
    const { association: _dropped, ...nomination } = readers.nominateSources!(input); return nomination;
  } };
  const baseline = sourceOrder(env, without), expected = [...baseline];
  expect(baseline.slice(0, 6)).toEqual(roots.slice(0, 6));
  expect(new Set(baseline)).toEqual(new Set(roots));
  [expected[4], expected[5]] = [expected[5]!, expected[4]!];
  expect(sourceOrder(env, readers)).toEqual(expected);

  process.execArgv.push(PROVIDER_FREE_WORKER_IMPORT);
  let client;
  try { client = createRecallReadWorkerClient({ databaseFilename: env.filename, workerUrl: builtWorkerUrl, workerCount: 1 })!; }
  finally { process.execArgv.splice(process.execArgv.lastIndexOf(PROVIDER_FREE_WORKER_IMPORT), 1); }
  try {
    await client.ready();
    const request = { workspace_id: WORKSPACE, query_text: QUERY, prepared_query: prepared,
      snapshot_id: snapshotIdFromPin(WORKSPACE, readers.snapshotPin!(WORKSPACE)),
      budget: { schema_version: 1 as const, work_units: 1_000_000, memory_bytes: 16_000_000,
        page_budget: 5, finalization_reserve: 512, min_envelope: 10 },
      interpretation_clock: START, as_of: START, expires_at: "2099-01-01T00:00:00.000Z", authorized_scopes: ["project"],
      enumeration_policy: "native_query" as const, result_kind_view: "source_only" as const,
      protocol_version: 1 as const, supported_result_kinds: ["memory_entry", "source_evidence"] as const,
      supports_source_evidence: true, supports_product_updates: true };
    const delivered: string[] = [];
    let page = await client.conditionalFieldPort.recall(request), pageCount = 0;
    expect(page.execution_receipt?.actual?.phases.acquire?.budget_work).toBeGreaterThan(0);
    while (true) {
      delivered.push(...page.index.entries.flatMap(entry => entry.target.kind === "source_evidence" ? [entry.target.root_id] : []));
      pageCount++;
      if (page.index.continuation === null) break;
      if (page.preparation_id === undefined) throw new Error("worker delivery preparation required");
      await client.conditionalFieldPort.acknowledge!(page.preparation_id, page.index, new Map(Object.entries(page.previews)));
      page = await client.conditionalFieldPort.recall({ ...request, continuation: page.index.continuation });
      expect(page.execution_receipt?.actual?.phases.acquire?.budget_work).toBe(0);
      expect(pageCount).toBeLessThan(10);
    }
    expect(pageCount).toBeGreaterThan(1);
    expect(delivered).toEqual(expected);
  } finally { await client.close(); }
}, 60_000);
