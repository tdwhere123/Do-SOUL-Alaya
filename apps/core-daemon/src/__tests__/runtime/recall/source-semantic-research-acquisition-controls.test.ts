import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { SourceIndexAcquisition, createAuditedSourceAdmission, fieldContractSha256,
  encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { unavailableSourceQueryPreparation, sourceSemanticAccessPhases, sourceSemanticExecutionPhases,
  SourceSemanticExecutionSchema, sourceDisclosure, qualifySourceDisclosure } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteSourceIndexRepository, type StorageDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticsPublicPayloadSchema, parseWorkerOperationPayload, parseWorkerOperationResult } from
  "../../../runtime/recall-read-worker/operation-schemas.js";
import type { RecallReadWorkerRequest } from "../../../runtime/recall-read-worker/protocol.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import {
  bindResearchSourceAcquisitionClient, compareResearchSourceAcquisitionControls, researchSourceAcquisitionClient,
  type ResearchSourceAcquisitionPort
} from "../../../runtime/recall/source-semantic-research-acquisition-controls.js";
import { BUDGET, CLOCK, ORIGINAL, WS, payload, query, queryClient } from "./source-semantic-query-preparation-fixture.js";
import type { ResearchSourceAcquisitionReply } from
  "../../../runtime/recall-read-worker/source-semantic-research-nominated-library.js";
import { nominatedLibraryContext, BODY, CONDITION, ANSWER, ORIGINAL as NOMINATED_QUERY, digest } from
  "./source-semantic-nominated-library.test-support.js";

const recallInput = () => payload({
  kind: "recall", original_query: ORIGINAL, query_semantics: query(),
  accepts_unreviewed_conditional_results: true, access_policy: "query-conditioned-v1",
  budget: BUDGET, output_byte_limit: 1_000_000
});
async function admitForeignSource(database: StorageDatabase, sourceId = "foreign-write") {
  const admission = createAuditedSourceAdmission({
    stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
    eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
    sha256: fieldContractSha256
  });
  await admission.admit({
    workspace_id: WS, source_id: sourceId, source_version: "1", content_bytes: "Foreign committed source.",
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: []
  }, { workspaceId: WS });
}
type Comparison = Awaited<ReturnType<typeof compareResearchSourceAcquisitionControls>>;
type Control = "lexical" | "vector" | "dual";
function completedArm(arm: Comparison["arm_envelopes"][Control]) {
  if (arm.kind !== "PRIVATE_COUNTERFACTUAL") throw new Error(`expected completed arm, got ${arm.kind}`);
  return arm;
}
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function captureReplies(host: NonNullable<ResearchSourceAcquisitionPort["researchAcquisition"]>) {
  const replies = new Map<Control, ResearchSourceAcquisitionReply>();
  const dispatch = host.dispatch.bind(host);
  vi.spyOn(host, "dispatch").mockImplementation(async (input, prepared, control) => {
    const reply = await dispatch(input, prepared, control);
    replies.set(control, structuredClone(reply));
    return reply;
  });
  return replies;
}
function expectRetainedReplies(comparison: Comparison, replies: ReadonlyMap<Control, ResearchSourceAcquisitionReply>) {
  expect(replies.size).toBeGreaterThan(0);
  for (const [control, reply] of replies) {
    const arm = completedArm(comparison.arm_envelopes[control]);
    expect(arm.private_delivery).toEqual(reply.private_delivery);
    expect(arm.full_envelope_bytes).toBe(jsonBytes(reply.result));
    expect(arm.full_envelope_bytes).toBeLessThan(jsonBytes(reply));
    expect(arm.work).toEqual(reply.result.work);
    expect(arm.execution).toEqual(reply.result.execution);
    expect(arm.artifact).not.toHaveProperty("private_delivery");
    expect(reply.result).not.toHaveProperty("private_delivery");
    expect(reply).not.toHaveProperty("work");
    expect(reply).not.toHaveProperty("execution");
  }
}

/** Instrument the built observation owner, not request counts or a transported parent pool. */
function instrumentWorkerObservation(failNominated = false) {
  const preload = `
    import ${JSON.stringify(new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href)};
    import { registerHooks } from "node:module";
    registerHooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const observation = url.endsWith("/source-semantic-candidate-access.js");
      const failure = ${failNominated} && url.endsWith("/source-semantic-library-nominated-windows.js");
      if (!observation && !failure) return loaded;
      let source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
      const name = observation ? "observeSourceSemanticAccess" : "prepareNominatedLibraryWindows";
      const marker = new RegExp("(export function " + name + "\\\\([^]*?\\\\) \\\\{)");
      if (!marker.test(source)) throw new Error("missing worker instrumentation owner: " + name);
      if (observation) {
        source = 'import { appendFileSync as recordAccess } from "node:fs"; import { workerData as accessWorker } from "node:worker_threads";\\n' +
          source.replace(marker, '$1\\n recordAccess(accessWorker.databaseFilename + ".research-observations", JSON.stringify({ control: payload.acquisition_control ?? null, in_transaction: runtime.database.connection.inTransaction }) + "\\\\n");');
      } else {
        source = source.replace(marker, '$1\\n meter.charge(7, 11, "authored nominated hydration failure"); throw new SourceSemanticResourceExhausted("authored nominated hydration failure");');
      }
      return { ...loaded, source };
    } });`;
  const argument = `--import=data:text/javascript,${encodeURIComponent(preload)}`;
  process.execArgv.push(argument);
  onTestFinished(() => { const index = process.execArgv.lastIndexOf(argument); if (index !== -1) process.execArgv.splice(index, 1); });
  return {
    observations: (filename: string) => readFileSync(`${filename}.research-observations`, "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { control: Control | null; in_transaction: boolean })
  };
}
function sourceIds(arm: { artifact: { discovery: { eligible_source_count: number; access?: { source_candidates: readonly { source_id: string }[] } } } }) {
  return {
    count: arm.artifact.discovery.eligible_source_count,
    ids: (arm.artifact.discovery.access?.source_candidates ?? []).map(row => row.source_id).sort()
  };
}
type ResearchHost = NonNullable<Awaited<ReturnType<typeof queryClient>>["client"]["researchAcquisition"]>;
function wrapDispatch(host: ResearchHost, afterLexical: () => Promise<void>) {
  const mutable = host as { dispatch: ResearchHost["dispatch"] };
  const real = host.dispatch.bind(host);
  mutable.dispatch = async (input, prepared, control) => {
    const result = await real(input, prepared, control);
    if (control === "lexical") await afterLexical();
    return result;
  };
  return () => { mutable.dispatch = real; };
}
const observePosts = (transform?: (request: RecallReadWorkerRequest) => RecallReadWorkerRequest) => {
  const nativePost = Worker.prototype.postMessage;
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    if (transform !== undefined) args[0] = transform(args[0] as RecallReadWorkerRequest);
    nativePost.apply(this, args);
  });
  return { calls: () => spy.mock.calls.map((args, index) => ({
    request: args[0] as RecallReadWorkerRequest, worker: spy.mock.contexts[index] as Worker
  })) };
};

describe("public schema cannot enable the private sibling", () => {
  it("rejects acquisition_control on the public payload and admits it only on the worker envelope", () => {
    const publicPayload = recallInput();
    expect(SourceSemanticsPublicPayloadSchema.safeParse({
      ...publicPayload, acquisition_control: "lexical"
    }).success).toBe(false);
    expect(SourceSemanticsPublicPayloadSchema.safeParse(publicPayload).success).toBe(true);
    const prepared = {
      receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
      vector: { status: "unavailable" as const, reason: SourceIndexAcquisition.channelNotRequested }
    };
    expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", {
      ...publicPayload, prepared_query: prepared, acquisition_control: "lexical"
    })).not.toThrow();
  });
});

describe("native worker acquisition controls", () => {
  it("prepares once, observes once per arm on one worker and SQLite snapshot, then rolls back", async () => {
    const observations = instrumentWorkerObservation();
    const h = await queryClient();
    const replies = captureReplies(h.client.researchAcquisition!);
    const posts = observePosts();
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(comparison.outcome).toBe("complete");
      if (comparison.outcome !== "complete") throw new Error("expected complete");
      expect(h.bind).toHaveBeenCalledTimes(1);
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expectRetainedReplies(comparison, replies);
      expect(observations.observations(h.filename)).toEqual([
        { control: "lexical", in_transaction: true }, { control: "vector", in_transaction: true }, { control: "dual", in_transaction: true }
      ]);
      expect(comparison.physical_prepare_once.submitted_inputs).toBe(1);
      expect(comparison.physical_prepare_once.receipt?.status).toBe("ready");
      expect(comparison.physical_prepare_once.attributed_to).toEqual(["vector", "dual"]);
      const lexical = completedArm(comparison.arm_envelopes.lexical);
      const vector = completedArm(comparison.arm_envelopes.vector);
      const dual = completedArm(comparison.arm_envelopes.dual);
      const lexicalPrep = sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(
        lexical.execution)).query_preparation;
      expect(lexicalPrep.status).toBe("not_requested");
      expect(lexicalPrep.reason).toBe(SourceIndexAcquisition.channelNotRequested);
      const lexicalAcq = sourceSemanticAccessPhases(lexical.artifact.discovery.access!).acquisition;
      expect(lexicalAcq.result?.vector.completion).toBe("not_run");
      expect(lexicalAcq.result?.vector.completion).not.toBe("unavailable");
      const vectorAcq = sourceSemanticAccessPhases(vector.artifact.discovery.access!).acquisition;
      expect(vectorAcq.result?.lexical.completion).toBe("not_run");
      expect(vectorAcq.result?.lexical.reason).toBe(SourceIndexAcquisition.channelNotRequested);
      const dualAcq = sourceSemanticAccessPhases(dual.artifact.discovery.access!).acquisition;
      expect(dualAcq.result?.lexical.completion).not.toBe("not_run");
      expect(lexical.private_delivery).toMatchObject({ status: "partial", reason: "comparison_states_differ", failure: null,
        nominated_comparison: { status: "unavailable", reason: "no_located_nominations", failure: null },
        lexical_prefix: { status: "not_run", reason: "supplied_query_semantics_not_absence" } });
      const reply = replies.get("dual")!;
      expect(parseWorkerOperationResult("conditionalField.sourceSemantics", reply)).toEqual(reply);
      for (const malformed of [
        { ...reply, extra: true }, { ...reply, private_delivery: { ...reply.private_delivery, extra: true } },
        { ...reply, result: { ...reply.result, private_delivery: reply.private_delivery } },
        { ...reply, private_delivery: { ...reply.private_delivery, status: "not_run" } }
      ]) expect(() => parseWorkerOperationResult("conditionalField.sourceSemantics", malformed)).toThrow();
      const { lexical_prefix: _lexical, nominated_comparison: _nominated, ...legacyDelivery } = reply.private_delivery;
      const notRun = { ...reply, private_delivery: { ...legacyDelivery, status: "not_run",
        reason: "live_access_pool_unavailable", comparison: null, costs: [] } };
      expect(parseWorkerOperationResult("conditionalField.sourceSemantics", notRun)).toEqual(notRun);
      for (const arm of [lexical, vector, dual]) {
        expect(arm.artifact).not.toHaveProperty("delivery_id");
        expect(arm.artifact).not.toHaveProperty("request_identity");
        expect(arm.artifact.index).not.toHaveProperty("continuation");
        expect(arm.request_budget).toEqual(BUDGET);
      }
      const semantics = posts.calls().filter(row => row.request.operation === "conditionalField.sourceSemantics");
      expect(semantics).toHaveLength(3);
      expect(new Set(semantics.map(row => row.worker)).size).toBe(1);
      expect(semantics.map(row => row.request.payload).map(payload =>
        (payload as { acquisition_control?: string }).acquisition_control)).toEqual(["lexical", "vector", "dual"]);
      expect(SourceSemanticsPublicPayloadSchema.safeParse(semantics[0]!.request.payload).success).toBe(false);
      const sql = h.observations();
      expect(sql.filter(row => row.sql === "BEGIN DEFERRED")).toHaveLength(1);
      expect(sql.filter(row => row.sql === "ROLLBACK")).toHaveLength(1);
      expect(sql.filter(row => row.sql === "COMMIT")).toEqual([]);
      await expect(h.client.researchAcquisition!.dispatch(recallInput(), {
        receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
        vector: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested }
      }, "lexical")).rejects.toThrow(/not isolated/);
    } finally { await h.cleanup(); }
  });

  it("keeps a tight native fitted page and byte quote independent of its larger private diagnostics", async () => {
    const h = await queryClient();
    try {
      const roomy = await h.client.sourceSemanticsPort!.execute(recallInput());
      if (roomy.kind !== "recall") throw new Error("native recall required");
      // Independent full-encoder reservation, retaining real phases and source qualifications.
      const mandatory = encodeSourceSemanticLibraryResponse({ ...roomy,
        source_disclosures: Object.fromEntries(Object.entries(roomy.source_disclosures).map(([key, value]) =>
          [key, qualifySourceDisclosure(value, sourceDisclosure(value).proof_use.kind, false)])),
        work: { native_work: BUDGET.work_units, index_work: BUDGET.work_units, native_accounting: "partial",
          logical_work: BUDGET.work_units, native_bytes: BUDGET.memory_bytes,
          logical_memory_bytes: BUDGET.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER }
      });
      const input = recallInput();
      if (input.request.kind !== "recall") throw new Error("initial recall required");
      // Allow timing-number width changes between physical preparations, not the private diagnostic bytes.
      input.request = { ...input.request, output_byte_limit: Math.ceil((jsonBytes(mandatory) + 128) / 1024) * 1024 };
      const native = await h.client.sourceSemanticsPort!.execute(input);
      if (native.kind !== "recall") throw new Error("native fitted recall required");
      expect(native.index.entries.length).toBeGreaterThan(0);
      const replies = captureReplies(h.client.researchAcquisition!);
      const comparison = await compareResearchSourceAcquisitionControls(h.client, input);
      expect(comparison.outcome).toBe("complete");
      expectRetainedReplies(comparison, replies);
      const dual = completedArm(comparison.arm_envelopes.dual), reply = replies.get("dual")!;
      expect(dual.artifact.index.entries).toEqual(native.index.entries);
      expect(dual.artifact.previews).toEqual(native.previews);
      expect(jsonBytes(encodeSourceSemanticLibraryResponse(reply.result))).toBeLessThanOrEqual(input.request.output_byte_limit);
      expect(jsonBytes(reply)).toBeGreaterThan(input.request.output_byte_limit);
      expect(dual.private_delivery.comparison!.hydration.prefix!.artifact.index.entries).toEqual(native.index.entries);
    } finally { await h.cleanup(); }
  });

  it("retains metered diagnostic exhaustion and native replies through strict worker IPC", async () => {
    const observations = instrumentWorkerObservation(true);
    const h = await queryClient();
    const replies = captureReplies(h.client.researchAcquisition!);
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("complete"); // Acquisition succeeded; diagnostics are independently partial.
      expectRetainedReplies(comparison, replies);
      for (const control of ["lexical", "vector", "dual"] as const) {
        const arm = completedArm(comparison.arm_envelopes[control]), diagnostics = arm.private_delivery;
        expect(diagnostics).toMatchObject({ status: "partial", reason: "comparison_failed",
          failure: { phase: "authored nominated hydration failure" } });
        expect(diagnostics.comparison!.hydration.prefix).not.toBeNull();
        expect(diagnostics.comparison!.hydration.nominated).toBeNull();
        expect(diagnostics.comparison!.ordering.native).toBeNull();
        expect(diagnostics.costs.some(row => row.phase === "prefix")).toBe(true);
        expect(diagnostics.costs.find(row => row.phase === "nominated_preparation")!.work.logical_work)
          .toBeGreaterThan(diagnostics.captured.work.logical_work! + 7);
        expect(arm.artifact.index.entries.length).toBeGreaterThan(0);
        for (const cost of diagnostics.costs) {
          expect(cost.work.logical_work).toBeGreaterThanOrEqual(diagnostics.captured.work.logical_work!);
          expect(cost.work.index_work).toBe(diagnostics.captured.work.index_work);
        }
      }
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(observations.observations(h.filename).map(row => row.control)).toEqual(["lexical", "vector", "dual"]);
      expect(h.observations().filter(row => row.sql === "ROLLBACK")).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it.each(["research", "ordinary"] as const)("rejects a native/private reply mismatch on %s execution", async route => {
    const h = await queryClient();
    observePosts(request => {
      if (request.operation !== "conditionalField.sourceSemantics") return request;
      const { acquisition_control: _control, ...payload } = request.payload as Record<string, unknown>;
      return { ...request, payload: { ...payload, ...(route === "ordinary" ? { acquisition_control: "dual" } : {}) } };
    });
    try {
      if (route === "ordinary") {
        await expect(h.client.sourceSemanticsPort!.execute(recallInput())).rejects.toThrow(/cannot accept a private research reply/);
      } else {
        const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
        expect(comparison.outcome).toBe("partial");
        if (comparison.outcome !== "partial") throw new Error("expected partial");
        expect(comparison.arm_envelopes.lexical.kind).toBe("not_completed");
        expect(String(comparison.failure.cause)).toMatch(/requires its private reply/);
      }
    } finally { await h.cleanup(); }
  });

  it("rejects a forged lexical embedding on the isolated research dispatch", async () => {
    const h = await queryClient();
    try {
      await h.client.readSnapshot.isolate!(async () => {
        const prepared = await h.client.researchAcquisition!.prepareQuery(recallInput());
        await expect(h.client.researchAcquisition!.dispatch(recallInput(), prepared, "lexical"))
          .rejects.toThrow(/cannot carry a query embedding/);
      });
    } finally { await h.cleanup(); }
  });

  it("pins all three arms against a second-connection source commit between lexical and vector", async () => {
    const h = await queryClient();
    const host = h.client.researchAcquisition!;
    const restore = wrapDispatch(host, async () => { await admitForeignSource(h.database); });
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("complete");
      if (comparison.outcome !== "complete") throw new Error("expected complete");
      const pinned = sourceIds(completedArm(comparison.arm_envelopes.lexical));
      expect(pinned.count).toBe(1);
      expect(pinned.ids).toEqual(["query-source"]);
      expect(sourceIds(completedArm(comparison.arm_envelopes.vector))).toEqual(pinned);
      expect(sourceIds(completedArm(comparison.arm_envelopes.dual))).toEqual(pinned);
      const sql = h.observations();
      expect(sql.filter(row => row.sql === "BEGIN DEFERRED")).toHaveLength(1);
      expect(sql.filter(row => row.sql === "ROLLBACK")).toHaveLength(1);
      expect(sql.filter(row => row.sql === "COMMIT")).toEqual([]);
      const after = await h.client.sourceSemanticsPort!.execute(recallInput());
      if (after.kind !== "recall") throw new Error("recall expected after rollback");
      expect(after.discovery.eligible_source_count).toBe(2);
      expect((after.discovery.access?.source_candidates ?? []).map(row => row.source_id).sort())
        .toEqual(["foreign-write", "query-source"]);
    } finally { restore(); await h.cleanup(); }
  });

  it("rolls back the snapshot when a later arm fails", async () => {
    const h = await queryClient();
    const host = h.client.researchAcquisition!;
    const mutable = host as { dispatch: ResearchHost["dispatch"] };
    const replies = captureReplies(host);
    const real = host.dispatch.bind(host);
    mutable.dispatch = async (input, prepared, control) => {
      if (control === "vector") throw new Error("vector arm failed");
      return await real(input, prepared, control);
    };
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("partial");
      if (comparison.outcome !== "partial") throw new Error("expected partial");
      expect(comparison.physical_prepare_once.receipt?.status).toBe("ready");
      expect(comparison.physical_prepare_once.attributed_to).toEqual(["vector", "dual"]);
      expect(comparison.arm_envelopes.lexical.kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(comparison.arm_envelopes.vector.kind).toBe("not_completed");
      expect(comparison.arm_envelopes.dual.kind).toBe("not_completed");
      expect(String(comparison.failure?.cause)).toMatch(/vector arm failed/);
      expectRetainedReplies(comparison, replies);
      const sql = h.observations();
      expect(sql.filter(row => row.sql === "BEGIN DEFERRED")).toHaveLength(1);
      expect(sql.filter(row => row.sql === "ROLLBACK")).toHaveLength(1);
      expect(sql.filter(row => row.sql === "COMMIT")).toEqual([]);
      await expect(host.dispatch(recallInput(), {
        receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
        vector: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested }
      }, "lexical")).rejects.toThrow(/not isolated/);
    } finally { mutable.dispatch = real; await h.cleanup(); }
  });

  it("keeps physical receipt and completed arms when rollback fails after success", async () => {
    const h = await queryClient();
    const replies = captureReplies(h.client.researchAcquisition!);
    const snapshot = h.client.readSnapshot as { rollback: () => Promise<void> };
    const real = snapshot.rollback.bind(snapshot);
    snapshot.rollback = async () => { throw new Error("rollback failed"); };
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("failed");
      if (comparison.outcome !== "failed") throw new Error("expected failed");
      expect(comparison.cleanup).toEqual({ rollback: "failed", worker_reusable: false });
      expect(comparison.physical_prepare_once.receipt?.status).toBe("ready");
      expect(completedArm(comparison.arm_envelopes.lexical).kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(completedArm(comparison.arm_envelopes.vector).kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(completedArm(comparison.arm_envelopes.dual).kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(comparison.failure.phase).toBe("cleanup");
      expect(String(comparison.failure.cause)).toMatch(/rollback failed/);
      expect(comparison.failure.earlier).toBeUndefined();
      expectRetainedReplies(comparison, replies);
    } finally { snapshot.rollback = real; await h.cleanup(); }
  });

  it("keeps physical receipt, completed lexical arm, and earlier cause when rollback fails after an arm error", async () => {
    const h = await queryClient();
    const host = h.client.researchAcquisition!;
    const dispatch = host as { dispatch: ResearchHost["dispatch"] };
    const replies = captureReplies(host);
    const realDispatch = host.dispatch.bind(host);
    dispatch.dispatch = async (input, prepared, control) => {
      if (control === "vector") throw new Error("vector arm failed");
      return await realDispatch(input, prepared, control);
    };
    const snapshot = h.client.readSnapshot as { rollback: () => Promise<void> };
    const realRollback = snapshot.rollback.bind(snapshot);
    snapshot.rollback = async () => { throw new Error("rollback failed"); };
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("partial");
      if (comparison.outcome !== "partial") throw new Error("expected partial");
      expect(comparison.cleanup).toEqual({ rollback: "failed", worker_reusable: false });
      expect(comparison.physical_prepare_once.receipt?.status).toBe("ready");
      expect(comparison.arm_envelopes.lexical.kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(comparison.arm_envelopes.vector.kind).toBe("not_completed");
      expect(comparison.failure.phase).toBe("cleanup");
      expect(comparison.failure.earlier?.phase).toBe("vector");
      expect(String(comparison.failure.earlier?.cause)).toMatch(/vector arm failed/);
      expectRetainedReplies(comparison, replies);
    } finally { dispatch.dispatch = realDispatch; snapshot.rollback = realRollback; await h.cleanup(); }
  });

  it("keeps physical receipt when isolate rejects after the comparison callback returns", async () => {
    const h = await queryClient();
    const replies = captureReplies(h.client.researchAcquisition!);
    const snapshot = h.client.readSnapshot as {
      isolate: <T>(work: () => Promise<T>) => Promise<T>;
    };
    const realIsolate = snapshot.isolate.bind(snapshot);
    snapshot.isolate = async work => {
      const value = await realIsolate(work);
      throw new Error("isolate exit");
    };
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("failed");
      if (comparison.outcome !== "failed") throw new Error("expected failed");
      expect(comparison.cleanup).toEqual({ rollback: "unknown", worker_reusable: false });
      expect(comparison.physical_prepare_once.receipt?.status).toBe("ready");
      expect(completedArm(comparison.arm_envelopes.lexical).kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(comparison.failure.phase).toBe("cleanup");
      expect(String(comparison.failure.cause)).toMatch(/isolate exit/);
      expectRetainedReplies(comparison, replies);
    } finally { snapshot.isolate = realIsolate; await h.cleanup(); }
  });

  it("returns a non-ready preparation receipt without beginning or dispatching arms", async () => {
    const h = await queryClient();
    const posts = observePosts();
    h.bind.mockImplementationOnce(async () => ({ status: "unsupported", reason: "fixture_unavailable" }) as never);
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("unavailable");
      if (comparison.outcome !== "unavailable") throw new Error("expected unavailable");
      expect(comparison.physical_prepare_once.receipt?.status).toBe("unavailable");
      expect(comparison.physical_prepare_once.receipt?.reason).toBe("fixture_unavailable");
      expect(comparison.physical_prepare_once.receipt?.binding_work).toBe("unknown");
      expect(comparison.physical_prepare_once.receipt).toHaveProperty("external_api_attempts");
      expect(comparison.arm_envelopes.lexical.kind).toBe("not_completed");
      expect(posts.calls().filter(row => row.request.operation === "conditionalField.sourceSemantics")).toHaveLength(0);
      expect(h.observations().filter(row => row.sql === "BEGIN DEFERRED")).toHaveLength(0);
    } finally { await h.cleanup(); }
  });

  it("keeps a late-deadline preparation receipt and does not begin or dispatch", async () => {
    const h = await queryClient();
    const posts = observePosts();
    const host = h.client.researchAcquisition!;
    const mutable = host as { prepareQuery: ResearchHost["prepareQuery"] };
    const real = host.prepareQuery.bind(host);
    mutable.prepareQuery = async input => {
      const prepared = await real(input);
      const error = new Error("preparation_deadline");
      Object.defineProperty(error, "researchPreparedQuery", { value: prepared, enumerable: false });
      throw error;
    };
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("failed");
      if (comparison.outcome !== "failed") throw new Error("expected failed");
      expect(comparison.physical_prepare_once.receipt?.status).toBe("ready");
      expect(String(comparison.failure.cause)).toMatch(/preparation_deadline/);
      expect(comparison.arm_envelopes.lexical.kind).toBe("not_completed");
      expect(posts.calls().filter(row => row.request.operation === "conditionalField.sourceSemantics")).toHaveLength(0);
      expect(h.observations().filter(row => row.sql === "BEGIN DEFERRED")).toHaveLength(0);
    } finally { mutable.prepareQuery = real; await h.cleanup(); }
  });

  it("unwinds a failed BEGIN through the snapshot owner and keeps the worker reusable", async () => {
    const h = await queryClient();
    const snapshot = h.client.readSnapshot as { beginDeferred: () => Promise<void>; rollback: () => Promise<void> };
    const realBegin = snapshot.beginDeferred.bind(snapshot);
    snapshot.beginDeferred = async () => { await realBegin(); throw new Error("begin ack lost"); };
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.outcome).toBe("failed");
      if (comparison.outcome !== "failed") throw new Error("expected failed");
      expect(comparison.failure.phase).toBe("begin");
      expect(comparison.physical_prepare_once.receipt?.status).toBe("ready");
      expect(comparison.arm_envelopes.lexical.kind).toBe("not_completed");
      const after = await h.client.sourceSemanticsPort!.execute(recallInput());
      expect(after.kind).toBe("recall");
    } finally { snapshot.beginDeferred = realBegin; await h.cleanup(); }
  });

  it("preserves the actual lexical arm when caller cancellation stops the remaining scoped arms", async () => {
    const h = await queryClient(), caller = new AbortController();
    const host = h.client.researchAcquisition!, dispatch = host.dispatch.bind(host), posts = observePosts();
    vi.spyOn(host, "dispatch").mockImplementation(async (input, prepared, control) => {
      if (control === "vector") caller.abort({ authored: "stop-after-lexical" });
      return await dispatch(input, prepared, control);
    });
    try {
      const result = await compareResearchSourceAcquisitionControls(h.client, recallInput(), { signal: caller.signal, timeoutMs: 5000 });
      expect(result.outcome).toBe("partial");
      expect(result.physical_prepare_once.submitted_inputs).toBe(1);
      expect(result.arm_envelopes.lexical.kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(result.arm_envelopes.vector.kind).toBe("not_completed");
      expect(result.arm_envelopes.dual.kind).toBe("not_completed");
      expect(posts.calls().filter(row => row.request.operation === "conditionalField.sourceSemantics")).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it("bounds physical preparation by the caller execution scope without starting any native arm", async () => {
    const h = await queryClient({ embed: async () => await new Promise(() => undefined) });
    try {
      const result = await compareResearchSourceAcquisitionControls(h.client, recallInput(), { timeoutMs: 20 });
      expect(result.outcome).toBe("failed");
      expect(result.physical_prepare_once.submitted_inputs).toBe("unknown");
      expect(result.arm_envelopes.lexical.kind).toBe("not_completed");
      expect(result.cleanup).toMatchObject({ rollback: "unknown", worker_reusable: false });
    } finally { await h.cleanup(); }
  });

  it("production execute never attaches acquisition_control", async () => {
    const h = await queryClient();
    const posts = observePosts();
    try {
      const result = await h.client.sourceSemanticsPort!.execute(recallInput());
      expect(result.kind).toBe("recall");
      expect(result).not.toHaveProperty("private_delivery");
      expect(result).not.toHaveProperty("result");
      const sent = posts.calls().filter(row => row.request.operation === "conditionalField.sourceSemantics");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.request.payload).not.toHaveProperty("acquisition_control");
      expect(h.bind).toHaveBeenCalledTimes(1);
    } finally { await h.cleanup(); }
  });
});

describe("private runtime binding", () => {
  const fakePort = (): ResearchSourceAcquisitionPort => ({
    researchAcquisition: {
      withExecutionScope: async (_input, work) => await work(() => "waiting"),
      prepareQuery: async () => { throw new Error("fake prepare"); },
      dispatch: async () => { throw new Error("fake dispatch"); }
    },
    readSnapshot: {
      isolate: async work => await work(), beginDeferred: async () => undefined, rollback: async () => undefined,
      commit: async () => undefined
    }
  });

  it("rejects a missing bind and a duplicate bind without creating a worker", () => {
    expect(() => researchSourceAcquisitionClient({})).toThrow(/not bound/);
    const runtime = {};
    bindResearchSourceAcquisitionClient(runtime, fakePort());
    expect(() => bindResearchSourceAcquisitionClient(runtime, fakePort())).toThrow(/already bound/);
    expect(() => bindResearchSourceAcquisitionClient({}, {
      readSnapshot: { beginDeferred: async () => undefined, rollback: async () => undefined, commit: async () => undefined }
    })).toThrow(/native worker client/);
  });

  it("delivers qualified non-prefix text through the same dist daemon and adapter the bench runner resolves", async () => {
    const pkgRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { exports: { ".": { import: string } } };
    expect(pkg.exports["."].import).toBe("./dist/index.js");
    const daemonEntry = pathToFileURL(join(pkgRoot, pkg.exports["."].import)).href;
    const adapterUrl = new URL("./runtime/recall/source-semantic-research-acquisition-controls.js", daemonEntry);
    expect(adapterUrl.pathname.replaceAll("\\", "/")).toMatch(
      /\/dist\/runtime\/recall\/source-semantic-research-acquisition-controls\.js$/);
    const { createAlayaDaemonRuntime } = await import(daemonEntry);
    const distAdapter = await import(adapterUrl.href) as {
      researchSourceAcquisitionClient: typeof researchSourceAcquisitionClient;
      compareResearchSourceAcquisitionControls: typeof compareResearchSourceAcquisitionControls;
    };
    const observations = instrumentWorkerObservation();
    const context = await nominatedLibraryContext();
    const dataDir = dirname(context.filename);
    const configDir = join(tmpdir(), `alaya-bench-config-${randomUUID()}`);
    const original = {
      DATA_DIR: process.env.DATA_DIR, ALAYA_CONFIG_DIR: process.env.ALAYA_CONFIG_DIR,
      ALAYA_SQLITE_WRITE_QUEUE: process.env.ALAYA_SQLITE_WRITE_QUEUE,
      ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT
    };
    process.env.DATA_DIR = dataDir;
    process.env.ALAYA_CONFIG_DIR = configDir;
    process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    let runtime: Awaited<ReturnType<typeof createAlayaDaemonRuntime>> | undefined;
    try {
      await mkdir(configDir, { recursive: true });
      runtime = await createAlayaDaemonRuntime({ embeddingStartupProbe: "omit" });
      expect(() => researchSourceAcquisitionClient(runtime)).toThrow(/not bound/);
      const port = distAdapter.researchSourceAcquisitionClient(runtime);
      expect(port.researchAcquisition).toBeDefined();
      expect(port.readSnapshot.isolate).toBeTypeOf("function");
      const state = new SqliteSourceIndexRepository(context.database, fieldContractSha256).state(WS);
      if (!("selection" in state)) throw new Error("authored finite-vector selection required");
      const posts = observePosts();
      const embed = vi.fn(async (inputs: readonly { input_id: string; text: string }[]) => inputs.map(input => ({
        status: "embedded" as const, input_id: input.input_id, input_digest: digest(input.text),
        vector: new Float32Array([1, 0, 0]), token_count: 2, truncated: false as const
      })));
      // Replace only the external preparation callback; the bound daemon worker owns observation and delivery.
      const prepare = vi.spyOn(port.researchAcquisition!, "prepareQuery").mockImplementation(async input => {
        expect(posts.calls().filter(row => row.request.operation === "snapshot.beginDeferred")).toHaveLength(0);
        expect(input.request.kind === "recall" && input.request.original_query).toBe(NOMINATED_QUERY);
        return await SourceIndexAcquisition.prepareQuery({ navigation: NOMINATED_QUERY,
          selection: state.selection, signal: new AbortController().signal, remainingMs: () => 60_000,
          bind: async () => ({ status: "ready", profile: state.selection.configuration.profile,
            profile_id: state.selection.profile_id, embedInputs: embed }) });
      });
      const replies = captureReplies(port.researchAcquisition!);
      // The fixture's local capture is never copied to or restored inside the daemon.
      const { prepared_query: _fixturePreparation, acquisition_control: _fixtureControl, ...input } = context.payload;
      const comparison = await distAdapter.compareResearchSourceAcquisitionControls(port, input, { timeoutMs: 30_000 });
      expect(comparison.outcome).toBe("complete");
      expectRetainedReplies(comparison, replies);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(embed).toHaveBeenCalledTimes(1);
      expect(embed.mock.calls[0]![0].map(row => row.text)).toEqual([NOMINATED_QUERY]);
      expect(observations.observations(context.filename)).toEqual([
        { control: "lexical", in_transaction: true }, { control: "vector", in_transaction: true }, { control: "dual", in_transaction: true }
      ]);
      for (const control of ["vector", "dual"] as const) {
        const arm = completedArm(comparison.arm_envelopes[control]), diagnostics = arm.private_delivery;
        expect(diagnostics).toMatchObject({ status: "partial", reason: "comparison_states_differ", failure: null,
          nominated_comparison: { status: "complete", reason: null },
          lexical_prefix: control === "vector" ? { status: "not_run", reason: "lexical_channel_not_requested" }
            : { status: "partial", reason: "partial_delivery" } });
        const prefix = diagnostics.comparison!.hydration.prefix!, nominated = diagnostics.comparison!.hydration.nominated!;
        expect(prefix.artifact.results!.some(row => row.content_preview?.includes(ANSWER))).toBe(false);
        const row = nominated.artifact.results!.find(row => row.content_preview?.includes(CONDITION + ANSWER))!;
        expect(row).toBeDefined();
        if (row.target.kind !== "source_evidence" || row.target.span === undefined) throw new Error("located body span required");
        expect(row.target.root_id).toBe(context.records.find(record => record.source_id === "answer")!.identity);
        expect(row.target.span).toMatchObject({ content_start: 8192, content_complete: false, original_complete: false });
        const bytes = Buffer.from(BODY).subarray(row.target.span.content_start, row.target.span.content_end);
        expect(row.content_preview).toBe(bytes.toString("utf8"));
        expect(Buffer.byteLength(row.content_preview!)).toBe(bytes.length);
        expect(sourceDisclosure(row.source_disclosure!).proof_use).toEqual({ kind: "source_only", qualification: "not_current_proof" });
        expect(row.budget_state.within_budget).toBe(true);
        expect(nominated.artifact).not.toHaveProperty("proofs");
        expect(nominated.artifact.coverage?.conditional_computation).toBe("unexercised");
        expect(arm.artifact.previews && Object.values(arm.artifact.previews).some(text => text.includes(ANSWER))).toBe(false);
        expect(prefix.artifact.index.entries).toEqual(arm.artifact.index.entries);
        for (const diagnosticArm of [prefix, nominated, ...Object.values(diagnostics.comparison!.ordering)]) {
          expect(diagnosticArm!.full_envelope_bytes).toBeLessThanOrEqual(diagnosticArm!.output_byte_limit);
          expect(diagnosticArm!.artifact.execution).toEqual(diagnostics.captured.execution);
        }
      }
      const semantics = posts.calls().filter(row => row.request.operation === "conditionalField.sourceSemantics");
      expect(semantics).toHaveLength(3);
      expect(new Set(semantics.map(row => row.worker)).size).toBe(1);
      expect(posts.calls().filter(row => row.request.operation === "snapshot.beginDeferred")).toHaveLength(1);
      expect(posts.calls().filter(row => row.request.operation === "snapshot.rollback")).toHaveLength(1);
      expect(posts.calls().filter(row => row.request.operation === "snapshot.commit")).toHaveLength(0);
      await runtime.shutdown();
      await expect(distAdapter.compareResearchSourceAcquisitionControls(port, recallInput())).rejects.toThrow();
    } finally {
      try { await runtime?.shutdown(); } catch { /* already closed */ }
      if (original.DATA_DIR === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original.DATA_DIR;
      if (original.ALAYA_CONFIG_DIR === undefined) delete process.env.ALAYA_CONFIG_DIR;
      else process.env.ALAYA_CONFIG_DIR = original.ALAYA_CONFIG_DIR;
      if (original.ALAYA_SQLITE_WRITE_QUEUE === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
      else process.env.ALAYA_SQLITE_WRITE_QUEUE = original.ALAYA_SQLITE_WRITE_QUEUE;
      if (original.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT === undefined) delete process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
      else process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = original.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
      await context.close();
      await rm(configDir, { recursive: true, force: true });
    }
  }, 45_000);
});
