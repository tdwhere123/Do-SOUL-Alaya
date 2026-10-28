import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, type InformationIndex, type QueryInterpretationProposal, type RequestBudget } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { toSourceObserverRow, type ObserverReaders } from "../../../recall/conditional-field/observers/observe.js";
import { runConditionalFieldRecallWithReceipt } from "../../../recall/runtime/recall-service-runner.js";
import { replayIssuedDelivery, restoreField } from "../../../recall/runtime/index-continuation.js";
import { CoreError } from "../../../shared/errors.js";
import { defaultBudget, FAR_FUTURE_EXPIRY, INTERPRETATION_CLOCK, SNAPSHOT_ID }
  from "../conditional-field/reference/deployment.fixture.js";
import { WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { deploymentProposal } from "../conditional-field/reference/deployment-proposal.fixture.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("observation work refusal", () => {
  it.each([14, 20])("refuses a fresh %s-unit budget below one atomic observation while retaining incurred cost", async work => {
    const fixture = await openFixture();
    const error = refusal(() => recall(fixture.readers, work));
    expect(error.code).toBe("CONFLICT");
    expect(error.details).toMatchObject({
      outcome: "resource_exhausted", resource: "observation_work", phase: "seed",
      required_work: 10, available_work: work - 11,
      residuals: expect.arrayContaining([expect.objectContaining({ kind: "seed", status: "interrupted" })]),
      execution_receipt: {
        requested_budget: { work_units: work, finalization_reserve: 5 },
        actual: { native_visits: 3, phases: { index: { budget_work: 4 } } }
      }
    });
    expect(fixture.lexical).not.toHaveBeenCalled();
  });

  it("refuses atomic program preparation that cannot fit before observation starts", async () => {
    const fixture = await openFixture();
    const proposal = ownedTargetProposal();
    const error = refusal(() => recall(fixture.readers, 17, null, proposal));
    expect(error.details).toMatchObject({ outcome: "resource_exhausted", resource: "observation_work",
      phase: "program_compile", required_work: 7, available_work: 6,
      execution_receipt: { requested_budget: { work_units: 17 } } });
    expect(fixture.lexical).not.toHaveBeenCalled();
  });

  it("retains grounding progress from an empty page while the next observation cannot fit", async () => {
    const fixture = await openFixture();
    const first = recall(fixture.readers, 24);
    const before = restoreField(first.index.continuation);
    const continued = recall(fixture.readers, 20, first.index.continuation);
    const after = restoreField(continued.index.continuation);
    expect(continued.index.entries).toEqual([]);
    expect(continued.index.continuation).not.toBeNull();
    expect(after?.grounding_progress?.completed_steps).toBeGreaterThan(before?.grounding_progress?.completed_steps ?? 0);
  });

  it("refuses zero execution work after paying for the progress envelope", async () => {
    const fixture = await openFixture();
    const error = refusal(() => recall(fixture.readers, 10, null, undefined,
      { finalization_reserve: 4, min_envelope: 0 }));
    expect(error.details).toMatchObject({ outcome: "resource_exhausted", resource: "observation_work",
      available_work: 0, execution_receipt: { actual: { native_visits: 3, phases: { index: { budget_work: 4 } } } } });
    expect(fixture.lexical).not.toHaveBeenCalled();
  });

  it("refuses an unaffordable retained projection instead of issuing a token that replays itself", async () => {
    const fixture = await openFixture();
    const first = recall(fixture.readers, 24);
    let continuation = first.index.continuation;
    let retained = restoreField(continuation);
    let error: unknown;
    for (let page = 0; page < 8; page++) {
      retained = restoreField(continuation);
      let next: ReturnType<typeof recall>;
      try { next = recall(fixture.readers, 14, continuation); }
      catch (caught) { error = caught; break; }
      continuation = next.index.continuation;
    }
    expect(error).toBeInstanceOf(CoreError);
    if (!(error instanceof CoreError)) throw new Error("Recall kept replaying an unaffordable projection");
    expect(error.details).toMatchObject({ outcome: "resource_exhausted", resource: "projection_work",
      required_work: expect.any(Number), available_work: expect.any(Number) });
    expect(error.details!.required_work as number).toBeGreaterThan(error.details!.available_work as number);
    expect(restoreField(continuation)).toBe(retained);
    expect(replayIssuedDelivery(continuation!.continuation_id)).toBeUndefined();
    const resumed = recall(fixture.readers, 2_000, continuation);
    expect(resumed.index.entries.map(entry => entry.object_id)).toEqual([fixture.ids[0]]);
  });

  it.each([14, 20])("leaves a token refused under %s units usable by a later request with sufficient work", async work => {
    const fixture = await openFixture(2);
    await fixture.admitRelation({ evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000001401", assertionId: "retained-owner",
      sourceId: fixture.ids[0]!, targetId: fixture.ids[1]!, resultObjectId: fixture.ids[1]!, relationKind: "owns",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: "owns" });
    const proposal = ownedTargetProposal();
    const first = recall(fixture.readers, 18, null, proposal);
    const continuation = first.index.continuation;
    expect(continuation).not.toBeNull();
    expect(first.index.entries).toEqual([]);
    const retained = restoreField(continuation);
    expect(retained).toBeDefined();
    expect(retained?.compiled_automaton).toBeDefined();
    expect(retained?.seeds.length).toBe(0);
    expect(fixture.lexical).not.toHaveBeenCalled();
    const reads = fixture.lexical.mock.calls.length;
    const error = refusal(() => recall(fixture.readers, work, continuation, proposal));
    expect(error.details).toMatchObject({ outcome: "resource_exhausted", resource: "observation_work" });
    expect(fixture.lexical).toHaveBeenCalledTimes(reads);
    expect(restoreField(continuation)).toBe(retained);
    expect(replayIssuedDelivery(continuation!.continuation_id)).toBeUndefined();

    const retried = recall(fixture.readers, 2_000, continuation, proposal);
    expect(retried.index.completeness.logical_index).not.toBe("invalidated");
    expect(retried.index.entries.map(entry => entry.object_id)).toContain(fixture.ids[1]);
    expect(replayIssuedDelivery(continuation!.continuation_id)).toBeDefined();
  });
});

async function openFixture(count = 6) {
  const slice = await openSourceSlice(database => databases.add(database));
  const ids = Array.from({ length: count }, (_, index) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(1_401 + index).padStart(12, "0")}`);
  for (const [index, id] of ids.entries()) {
    await slice.writeMemory(id, `needle item ${index + 1}`, MemoryDimension.FACT);
  }
  const lexical = vi.fn<NonNullable<ObserverReaders["lexical"]>>(input =>
    slice.memoryReader.lexical(input.workspaceId, input.query, input.limit, input.nativeLimit, input.afterObjectId));
  const readers: ObserverReaders = {
    lexical,
    source: input => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return { row: page.row === null ? null : toSourceObserverRow(page.row),
        rowsRead: page.rowsRead, bytesRead: page.bytesRead, unavailable: page.unavailable };
    },
    relation: input => slice.relationReader.read(input.workspaceId, input.subject, input.predicate,
      input.limit, input.nativeLimit, input.afterAssertionId),
    snapshotPin: workspaceId => slice.indexProjection.observablePin(workspaceId)
  };
  return { readers, lexical, ids, admitRelation: slice.admitRelation };
}

function ownedTargetProposal(): QueryInterpretationProposal {
  return { ...deploymentProposal("needle"), program: {
    schema_version: 1, kind: "relation", relation_kind: "owns", source_variable: "source", target_variable: "target",
    guard: { schema_version: 1, kind: "query_predicate", variable: "target", time_scope: "none" },
    facet_mode: "same_path", threshold_milligrades: 0
  } };
}

function recall(readers: ObserverReaders, work: number, continuation: InformationIndex["continuation"] = null,
  interpretation_proposal?: QueryInterpretationProposal, budgetOverrides: Partial<RequestBudget> = {}) {
  return runConditionalFieldRecallWithReceipt({
    workspace_id: WS, query_text: "needle", readers, continuation, authorized_scopes: null,
    budget: defaultBudget({ work_units: work, finalization_reserve: 5, min_envelope: 1, page_budget: 1, ...budgetOverrides }),
    snapshot_id: SNAPSHOT_ID, interpretation_clock: INTERPRETATION_CLOCK, as_of: INTERPRETATION_CLOCK,
    expires_at: FAR_FUTURE_EXPIRY,
    ...(interpretation_proposal === undefined ? {} : { interpretation_proposal })
  });
}

function refusal(run: () => unknown): CoreError {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CoreError);
  if (!(error instanceof CoreError)) throw new Error("Recall did not return a typed refusal");
  return error;
}
