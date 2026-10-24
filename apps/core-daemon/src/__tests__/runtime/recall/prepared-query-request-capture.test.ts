import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, SourceIndexAcquisition, capableRecallConsumerDeclaration, fieldContractSha256,
  runConditionalFieldRecallWithReceipt, snapshotIdFromPin, type ConditionalFieldRecallRequest } from "@do-soul/alaya-core";
import { unavailableSourceQueryPreparation } from "@do-soul/alaya-protocol";
import { captureRecallRequest, withRecallEnvironment } from
  "../../../../../../packages/core/src/recall/runtime/captured-recall-request.js";
import { createDependencies, createTaskSurface } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { CLOCK, QUERY_BUDGET, SIMULATED_CONFIGURATION, WS, digest, withIndexedSources,
  type IndexFixture } from "./source-semantic-index-acquisition.test-support.js";

type Prepared = Awaited<ReturnType<IndexFixture["prepareQuery"]>>;
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const representation = { kind: "paired-prefix.v1" as const, query_prefix: "query: ", passage_prefix: "passage: " };
const configuration = { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, representation } };
const sources = [
  { id: "harbor", text: "Harbor opening was delayed.", vector: [1, 0, 0] },
  { id: "berth", text: "Berth assignments were published.", vector: [0, 1, 0] }
];

function requestFor(prepared: Prepared | undefined): ConditionalFieldRecallRequest {
  return { workspace_id: WS, query_text: "Why postponed?", prepared_query: prepared,
    budget: { ...QUERY_BUDGET, page_budget: 1 }, snapshot_id: snapshotIdFromPin(WS, undefined),
    interpretation_clock: CLOCK, as_of: CLOCK, expires_at: "2099-01-01T00:00:00.000Z", lifetime_now: CLOCK,
    authorized_scopes: null, readers: {}, ...capableRecallConsumerDeclaration() };
}

/** Both routes use nonzero-offset views of one caller buffer, including bytes outside
 * the views. Plain/class records have identical domain meaning. */
function mutableViews(prepared: Prepared, useClass: boolean) {
  class DomainRecord {}
  const record = <T extends object>(value: T): T => useClass ? Object.assign(new DomainRecord(), value) : value;
  const buffer = new Float32Array(12);
  const route = (value: Prepared, offset: number) => {
    if (value.vector.status !== "available") throw new Error("available fixture vector expected");
    const embedding = buffer.subarray(offset, offset + 3);
    embedding.set(value.vector.embedding);
    return record({ receipt: record(structuredClone(value.receipt) as Mutable<typeof value.receipt>), vector: record({ ...value.vector,
      profile: record(structuredClone(value.vector.profile) as Mutable<typeof value.vector.profile>), embedding }) });
  };
  const primary = route(prepared, 2), supplemental = route(prepared.supplemental!, 6);
  return { prepared: record({ ...primary, supplemental }), buffer };
}

it.each([false, true])("owns primary and supplemental Float32Array views and paired representation for class records %s", async useClass => {
  await withIndexedSources(sources, async fixture => {
    fixture.queryBinding.embedInputs.mockImplementation(async inputs => inputs.map(input => ({
      status: "embedded", input_id: input.input_id, input_digest: digest(input.text), role: input.role,
      prepared_input_digest: digest("query: " + input.text),
      vector: new Float32Array(input.text === "Berth" ? [0, 1, 0] : [1, 0, 0]), token_count: 2, truncated: false
    })));
    const produced = await fixture.prepareQuery({ navigation: "Why postponed?", supplemental_navigation: "Berth",
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const caller = mutableViews(produced, useClass), expectedReceipt = structuredClone(caller.prepared.receipt);
    const captured = captureRecallRequest(requestFor(caller.prepared));
    const patched = withRecallEnvironment(captureRecallRequest(requestFor(undefined)), { prepared_query: caller.prepared });
    const owned = captured.request.prepared_query!;
    // Mutate through the original buffer, both subarrays and an independently made byte view.
    caller.buffer.fill(9);
    caller.prepared.vector.embedding.fill(0);
    new DataView(caller.buffer.buffer).setFloat32(6 * 4, -8, true);
    caller.prepared.receipt.status = "failed";
    caller.prepared.vector.profile.representation!.query_prefix = "changed: ";
    for (const query of [owned, patched.prepared_query!]) {
      if (query.vector.status !== "available" || query.supplemental?.vector.status !== "available") {
        throw new Error("captured routes expected");
      }
      expect(query.vector.embedding).toBeInstanceOf(Float32Array);
      expect([...query.vector.embedding]).toEqual([1, 0, 0]);
      expect([...query.supplemental.vector.embedding]).toEqual([0, 1, 0]);
      expect(query.vector.embedding.byteOffset).toBe(0);
      expect(query.vector.embedding.buffer.byteLength).toBe(12);
      expect(query.vector.profile.representation).toEqual(representation);
      expect(query.receipt).toEqual(expectedReceipt);
      // A callback retaining a returned view or its buffer still cannot rewrite the capture.
      const retained = query.vector.embedding;
      retained.fill(0); new Uint8Array(retained.buffer).fill(255);
      query.supplemental.vector.embedding.fill(0);
      expect([...query.vector.embedding]).toEqual([1, 0, 0]);
      expect([...query.supplemental.vector.embedding]).toEqual([0, 1, 0]);
    }
    const unavailable = { vector: { status: "unavailable" as const, reason: "hint_refused" },
      receipt: unavailableSourceQueryPreparation("hint_refused") };
    const primaryOnly = captureRecallRequest(requestFor({ ...produced, supplemental: unavailable })).request.prepared_query!;
    const supplementalOnly = captureRecallRequest(requestFor({ ...unavailable, supplemental: produced })).request.prepared_query!;
    expect(primaryOnly.vector.status).toBe("available");
    expect(primaryOnly.supplemental).toEqual(unavailable);
    expect(supplementalOnly.vector).toEqual(unavailable.vector);
    expect(supplementalOnly.supplemental?.vector.status).toBe("available");
    expect(withRecallEnvironment(captured, { prepared_query: undefined }).prepared_query).toBeUndefined();
    expect(Object.isFrozen(caller.prepared)).toBe(false);
    expect(Object.isFrozen(caller.prepared.vector.embedding)).toBe(false);
    expect(Object.isFrozen(caller.buffer.buffer)).toBe(false);
    const acquisition = new SourceIndexAcquisition(fixture.repository, fieldContractSha256);
    for (const [navigation, route, expected] of [
      ["Why postponed?", owned, "harbor"], ["Berth", owned.supplemental!, "berth"]
    ] as const) {
      const result = acquisition.nominateWithWitness({ workspace_id: WS, navigation_text: navigation, vector: route.vector,
        allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 4096 }, budget: QUERY_BUDGET }, () => "admitted");
      expect(result.result.vector.validation).toBe("validated");
      const top = result.result.nominations.filter(row => row.vector !== null).sort((a, b) => a.vector!.rank - b.vector!.rank)[0];
      expect(top?.source.source_id).toBe(expected);
    }
    const readers = createConditionalFieldObserverReaders(fixture.database, [], owned.vector);
    const page = runConditionalFieldRecallWithReceipt({ ...withRecallEnvironment(captured), readers });
    expect(page.index.entries[0]?.target).toMatchObject({ kind: "source_evidence" });
    expect(page.execution_receipt.query_preparation).toEqual(expectedReceipt);
    expect(page.index.continuation).not.toBeNull();
    const next = runConditionalFieldRecallWithReceipt({ ...withRecallEnvironment(captured), readers, continuation: page.index.continuation });
    expect(next.index.query_id).toBe(page.index.query_id);
    expect(next.execution_receipt.query_preparation).toEqual(expectedReceipt);
    expect(next.index.entries[0]?.target).not.toEqual(page.index.entries[0]?.target);
  }, configuration);
});

it.each(["unavailable", "failed", "not_requested"] as const)("preserves %s preparation and absent supplemental without inventing a vector", status => {
  const receipt = { ...unavailableSourceQueryPreparation("fixture_refusal"), status };
  const route = { vector: { status: "unavailable" as const, reason: "fixture_refusal" }, receipt };
  const captured = captureRecallRequest(requestFor(route));
  receipt.reason = "changed"; route.vector.reason = "changed";
  expect(captured.request.prepared_query).toEqual({ vector: { status: "unavailable", reason: "fixture_refusal" },
    receipt: { ...unavailableSourceQueryPreparation("fixture_refusal"), status } });
  expect(Object.hasOwn(captured.request.prepared_query!, "supplemental")).toBe(false);
  const supplemental = captureRecallRequest(requestFor({ ...route, supplemental: route })).request.prepared_query!;
  expect(supplemental.supplemental?.receipt.status).toBe(status);
  expect(captureRecallRequest(requestFor(undefined)).request.prepared_query).toBeUndefined();
});

it("captures prepared vectors and receipts before public Core snapshot callbacks, then continues through the built SQLite worker", async () => {
  await withIndexedSources(sources, async fixture => {
    const prepare = fixture.prepareQuery.getMockImplementation()!;
    let caller: ReturnType<typeof mutableViews> | undefined;
    fixture.prepareQuery.mockImplementation(async input => {
      const prepared = await prepare({ ...input, supplemental_navigation: "Berth" });
      caller = mutableViews(prepared, true);
      return caller.prepared;
    });
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies(), now: () => CLOCK,
      readSnapshot: { ...client.readSnapshot, beginDeferred: async () => {
        if (caller !== undefined) {
          caller.buffer.fill(0);
          caller.prepared.receipt.status = "failed";
          caller.prepared.vector.profile.representation!.query_prefix = "changed: ";
        }
        await client.readSnapshot.beginDeferred();
      } }, conditionalFieldPort: client.conditionalFieldPort, activeConstraintsPort: client.activeConstraintsPort });
    const params = { workspaceId: WS, taskSurface: createTaskSurface(), strategy: "chat" as const,
      queryText: "Why postponed?", budget: { ...QUERY_BUDGET, page_budget: 1 }, ...capableRecallConsumerDeclaration() };
    const first = await service.recall(params);
    expect(first.execution_receipt?.query_preparation).toMatchObject({ status: "ready", navigation_digest: digest(params.queryText),
      selected: { profile: { representation } } });
    expect(first.candidates[0]?.content_preview).toContain("Harbor opening");
    expect(first.index.entries[0]?.navigation?.operator).toBe("source_vector");
    expect(first.index.continuation).not.toBeNull();
    expect(caller!.prepared.receipt.status).toBe("failed");
    expect([...caller!.prepared.vector.embedding]).toEqual([0, 0, 0]);
    const second = await service.recall({ ...params, continuation: first.index.continuation });
    expect(second.index.query_id).toBe(first.index.query_id);
    expect(second.index.entries[0]?.target).not.toEqual(first.index.entries[0]?.target);
    expect(second.candidates[0]?.content_preview).toContain("Berth assignments");
    expect(fixture.prepareQuery).toHaveBeenCalledTimes(1);
    expect(first.issued_delivery_id).toBeDefined(); expect(second.issued_delivery_id).toBeDefined();
  }, configuration);
});
