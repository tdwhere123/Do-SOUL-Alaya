import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { SourceIndexAcquisition, createAuditedSourceAdmission, fieldContractSha256 } from "@do-soul/alaya-core";
import { unavailableSourceQueryPreparation, sourceSemanticAccessPhases, sourceSemanticExecutionPhases,
  SourceSemanticExecutionSchema } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticsPublicPayloadSchema, parseWorkerOperationPayload } from
  "../../../runtime/recall-read-worker/operation-schemas.js";
import type { RecallReadWorkerRequest } from "../../../runtime/recall-read-worker/protocol.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import {
  bindResearchSourceAcquisitionClient, compareResearchSourceAcquisitionControls, researchSourceAcquisitionClient,
  type ResearchSourceAcquisitionPort
} from "../../../runtime/recall/source-semantic-research-acquisition-controls.js";
import { BUDGET, CLOCK, ORIGINAL, WS, payload, query, queryClient } from "./source-semantic-query-preparation-fixture.js";

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
function completedArm<T extends { kind: string }>(arm: T) {
  if (arm.kind !== "PRIVATE_COUNTERFACTUAL") throw new Error(`expected completed arm, got ${arm.kind}`);
  return arm as T & { kind: "PRIVATE_COUNTERFACTUAL"; execution?: unknown; artifact: { discovery: { eligible_source_count: number; access?: { source_candidates: readonly { source_id: string }[] } }; index: object }; request_budget: unknown };
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
const observePosts = () => {
  const nativePost = Worker.prototype.postMessage;
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
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
  it("prepares once, uses one worker and one SQLite read snapshot for three arms, then rolls back", async () => {
    const h = await queryClient();
    const posts = observePosts();
    try {
      const comparison = await compareResearchSourceAcquisitionControls(h.client, recallInput());
      expect(comparison.kind).toBe("PRIVATE_COUNTERFACTUAL");
      expect(comparison.outcome).toBe("complete");
      if (comparison.outcome !== "complete") throw new Error("expected complete");
      expect(h.bind).toHaveBeenCalledTimes(1);
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
    } finally { snapshot.rollback = real; await h.cleanup(); }
  });

  it("keeps physical receipt, completed lexical arm, and earlier cause when rollback fails after an arm error", async () => {
    const h = await queryClient();
    const host = h.client.researchAcquisition!;
    const dispatch = host as { dispatch: ResearchHost["dispatch"] };
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
    } finally { dispatch.dispatch = realDispatch; snapshot.rollback = realRollback; await h.cleanup(); }
  });

  it("keeps physical receipt when isolate rejects after the comparison callback returns", async () => {
    const h = await queryClient();
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

  it("production execute never attaches acquisition_control", async () => {
    const h = await queryClient();
    const posts = observePosts();
    try {
      await h.client.sourceSemanticsPort!.execute(recallInput());
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

  it("binds through the same dist daemon entry the bench runner resolves", async () => {
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
    const dataDir = join(tmpdir(), `alaya-bench-config-${randomUUID()}`);
    const original = {
      DATA_DIR: process.env.DATA_DIR, ALAYA_CONFIG_DIR: process.env.ALAYA_CONFIG_DIR,
      ALAYA_SQLITE_WRITE_QUEUE: process.env.ALAYA_SQLITE_WRITE_QUEUE,
      ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT
    };
    process.env.DATA_DIR = dataDir;
    process.env.ALAYA_CONFIG_DIR = dataDir;
    process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    await mkdir(dataDir, { recursive: true });
    const runtime = await createAlayaDaemonRuntime({ embeddingStartupProbe: "omit" });
    try {
      expect(() => researchSourceAcquisitionClient(runtime)).toThrow(/not bound/);
      const port = distAdapter.researchSourceAcquisitionClient(runtime);
      expect(port.researchAcquisition).toBeDefined();
      expect(port.readSnapshot.isolate).toBeTypeOf("function");
      await runtime.shutdown();
      await expect(distAdapter.compareResearchSourceAcquisitionControls(port, recallInput())).rejects.toThrow();
    } finally {
      try { await runtime.shutdown(); } catch { /* already closed */ }
      if (original.DATA_DIR === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original.DATA_DIR;
      if (original.ALAYA_CONFIG_DIR === undefined) delete process.env.ALAYA_CONFIG_DIR;
      else process.env.ALAYA_CONFIG_DIR = original.ALAYA_CONFIG_DIR;
      if (original.ALAYA_SQLITE_WRITE_QUEUE === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
      else process.env.ALAYA_SQLITE_WRITE_QUEUE = original.ALAYA_SQLITE_WRITE_QUEUE;
      if (original.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT === undefined) delete process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
      else process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = original.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45_000);
});
