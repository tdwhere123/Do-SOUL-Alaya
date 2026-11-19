import { afterEach, expect, it, vi } from "vitest";
import { SourceIndexBackfill } from "../../source-index/source-index-backfill.js";
import { SourceIndexLifecycle } from "../../source-index/source-index-lifecycle.js";
import { sourceEmbeddingInputDigest, type SourceEmbeddingInput, type SourceEmbeddingResult } from
  "../../embedding-recall/source-embedding-runtime.js";
import { BUDGET, WORKSPACE, configuration, fieldSha256, fixture, type Fixture } from
  "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishMessages, publishStatement } from
  "../../../../storage/src/__tests__/repos/source-index/source-template-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});

function embedded(inputs: readonly SourceEmbeddingInput[]): readonly SourceEmbeddingResult[] {
  return inputs.map(input => ({ status: "embedded" as const, input_id: input.input_id,
    input_digest: sourceEmbeddingInputDigest(input.text), vector: new Float32Array([0.6, 0.8, 0]), token_count: 2, truncated: false as const }));
}

it("embeds the published relation after statement-key windows complete and still reports root_complete on overlay failure", async () => {
  const environment = fixture(); environments.push(environment);
  const published = publishMessages(environment);
  const statement = publishStatement(environment, published, "relation-backfill");
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, configuration({ window_bytes: 4096, max_input_tokens: 4096 }));
  const generation = lifecycle.begin(selection);
  lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
  const target = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)
    .find(row => row.auxiliary !== undefined);
  if (target === undefined) throw new Error("expected statement key");
  const texts: string[] = [];
  const binding = { status: "ready" as const, profile: { ...selection.configuration.profile }, profile_id: selection.profile_id,
    embedInputs: vi.fn(async (inputs: readonly SourceEmbeddingInput[]) => {
      texts.push(inputs[0]!.text);
      return embedded(inputs);
    }) };
  const backfill = new SourceIndexBackfill(lifecycle);
  const input = { selection, generation_id: generation.generation_id, root_key: target.root_key, binding,
    budget: { ...BUDGET, model_inputs: 10, input_bytes: 4096, max_body_bytes: 4096 },
    deadline_ms: Date.now() + 60_000, signal: new AbortController().signal };
  const first = await backfill.step(input);
  expect(first.status).toBe("root_complete");
  expect(texts.at(-1)).toBe(statement.bound.statement.relation);
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_vectors").get()).toEqual({ n: 1 });
  const environment2 = fixture(); environments.push(environment2);
  const published2 = publishMessages(environment2, [{ role: "user", text: "second" }], "source-b");
  publishStatement(environment2, published2, "relation-backfill-2");
  const lifecycle2 = new SourceIndexLifecycle(environment2.index, fieldSha256);
  const selection2 = lifecycle2.select(WORKSPACE, configuration({ window_bytes: 4096, max_input_tokens: 4096 }));
  const generation2 = lifecycle2.begin(selection2);
  lifecycle2.capture(WORKSPACE, generation2.generation_id, 8, BUDGET);
  const target2 = environment2.index.listTargets(WORKSPACE, generation2.generation_id, null, 8)
    .find(row => row.auxiliary !== undefined)!;
  vi.spyOn(lifecycle2, "acceptRelationVector").mockImplementation(() => { throw new Error("overlay write failed"); });
  const binding2 = { status: "ready" as const, profile: { ...selection2.configuration.profile }, profile_id: selection2.profile_id,
    embedInputs: vi.fn(async (inputs: readonly SourceEmbeddingInput[]) => embedded(inputs)) };
  const second = await new SourceIndexBackfill(lifecycle2).step({
    selection: selection2, generation_id: generation2.generation_id, root_key: target2.root_key, binding: binding2,
    budget: { ...BUDGET, model_inputs: 10, input_bytes: 4096, max_body_bytes: 4096 },
    deadline_ms: Date.now() + 60_000, signal: new AbortController().signal });
  expect(second.status).toBe("root_complete");
});

it("returns root_complete when optional relation embedding times out without aborting the caller", async () => {
  const environment = fixture(); environments.push(environment);
  const published = publishMessages(environment);
  const statement = publishStatement(environment, published, "relation-timeout");
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, configuration({ window_bytes: 4096, max_input_tokens: 4096 }));
  const generation = lifecycle.begin(selection);
  lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
  const target = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)
    .find(row => row.auxiliary !== undefined);
  if (target === undefined) throw new Error("expected statement key");
  const parent = new AbortController();
  const relationSignals: AbortSignal[] = [];
  let relationAborted = false;
  const binding = { status: "ready" as const, profile: { ...selection.configuration.profile }, profile_id: selection.profile_id,
    embedInputs: vi.fn(async (inputs: readonly SourceEmbeddingInput[], options?: { signal?: AbortSignal }) => {
      if (inputs[0]!.text === statement.bound.statement.relation) {
        if (options?.signal !== undefined) {
          relationSignals.push(options.signal);
          options.signal.addEventListener("abort", () => { relationAborted = true; }, { once: true });
        }
        await new Promise<never>(() => undefined);
      }
      if (relationAborted) {
        return inputs.map(input => ({ status: "not_embedded" as const, reason: "stale_child",
          input_id: input.input_id, input_digest: sourceEmbeddingInputDigest(input.text), token_count: null }));
      }
      return embedded(inputs);
    }) };
  const started = Date.now();
  const deadlineMs = started + 400;
  const result = await new SourceIndexBackfill(lifecycle).step({
    selection, generation_id: generation.generation_id, root_key: target.root_key, binding,
    budget: { ...BUDGET, model_inputs: 10, input_bytes: 4096, max_body_bytes: 4096 },
    deadline_ms: deadlineMs, signal: parent.signal });
  expect(result.status).toBe("root_complete");
  expect(Date.now()).toBeLessThan(deadlineMs);
  expect(parent.signal.aborted).toBe(false);
  expect(relationAborted).toBe(false);
  expect(relationSignals.every(signal => signal.aborted === false)).toBe(true);
  expect(environment.index.pendingWindows(WORKSPACE, generation.generation_id, target.root_key, 1, BUDGET))
    .toMatchObject({ status: "ready", ordinals: [] });
  const other = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)
    .find(row => row.root_key !== target.root_key);
  if (other === undefined) throw new Error("expected a second root");
  const next = await new SourceIndexBackfill(lifecycle).step({
    selection, generation_id: generation.generation_id, root_key: other.root_key, binding,
    budget: { ...BUDGET, model_inputs: 10, input_bytes: 4096, max_body_bytes: 4096 },
    deadline_ms: Date.now() + 5_000, signal: parent.signal });
  expect(next.status).toBe("root_complete");
  expect(next.reason).not.toBe("stale_child");
});

it("writes the relation vector when overlay inference takes 80 ms under a 5000 ms deadline", async () => {
  const environment = fixture(); environments.push(environment);
  const published = publishMessages(environment);
  const statement = publishStatement(environment, published, "relation-minilm");
  const lifecycle = new SourceIndexLifecycle(environment.index, fieldSha256);
  const selection = lifecycle.select(WORKSPACE, configuration({ window_bytes: 4096, max_input_tokens: 4096 }));
  const generation = lifecycle.begin(selection);
  lifecycle.capture(WORKSPACE, generation.generation_id, 8, BUDGET);
  const target = environment.index.listTargets(WORKSPACE, generation.generation_id, null, 8)
    .find(row => row.auxiliary !== undefined);
  if (target === undefined) throw new Error("expected statement key");
  const binding = { status: "ready" as const, profile: { ...selection.configuration.profile }, profile_id: selection.profile_id,
    embedInputs: vi.fn(async (inputs: readonly SourceEmbeddingInput[]) => {
      if (inputs[0]!.text === statement.bound.statement.relation) {
        await new Promise(resolve => { setTimeout(resolve, 80); });
      }
      return embedded(inputs);
    }) };
  const result = await new SourceIndexBackfill(lifecycle).step({
    selection, generation_id: generation.generation_id, root_key: target.root_key, binding,
    budget: { ...BUDGET, model_inputs: 10, input_bytes: 4096, max_body_bytes: 4096 },
    deadline_ms: Date.now() + 5_000, signal: new AbortController().signal });
  expect(result.status).toBe("root_complete");
  expect(environment.database.connection.prepare(
    "SELECT count(*) AS n FROM source_statement_relation_vectors").get()).toEqual({ n: 1 });
});
