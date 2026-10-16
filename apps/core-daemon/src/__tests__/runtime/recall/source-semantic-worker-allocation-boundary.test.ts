import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError, createAuditedSourceAdmission, fieldContractSha256 } from "@do-soul/alaya-core";
import { unavailableSourceQueryPreparation } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient, type PrepareSourceQuery } from "../../../runtime/recall/recall-read-worker-client.js";
import { CLOCK, ORIGINAL, RAW, SCOPES, SIMULATED_CONFIGURATION, WS, digest }
  from "./source-semantic-index-acquisition.test-support.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";

const VECTOR_BACKING = 65_536;
const BUDGET = { schema_version: 1 as const, work_units: 8_000, memory_bytes: VECTOR_BACKING,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
const GUARD = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href}`;

function fakePreparedVector(): PrepareSourceQuery {
  return async () => {
    const embedding = new Float32Array(new ArrayBuffer(VECTOR_BACKING), 0, 3);
    embedding.set([1, 0, 0]);
    expect(embedding.buffer.byteLength).toBe(VECTOR_BACKING);
    return { receipt: unavailableSourceQueryPreparation("fixture_does_not_prepare"),
      vector: { status: "available", profile: SIMULATED_CONFIGURATION.profile,
        profile_id: SIMULATED_CONFIGURATION.profile.artifact_digest, input_digest: digest(ORIGINAL), embedding } };
  };
}

it("charges received vector backing on the actual worker then fails closed without stale execution", async () => {
  assertBuiltWorker();
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-allocation-boundary-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  process.execArgv.push(GUARD);
  let client: ReturnType<typeof createRecallReadWorkerClient> | undefined;
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      sha256: fieldContractSha256
    });
    await admission.admit({ workspace_id: WS, source_id: "raw", source_version: "1", content_bytes: RAW,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    database.close();
    closeCachedDatabase(filename);
    client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl,
      workerCount: 1, requestTimeoutMs: 5_000, prepareSourceQuery: fakePreparedVector() });
    if (client === null) throw new Error("expected worker client");
    await client.ready();
    let caught: unknown;
    try {
      await client.sourceSemanticsPort!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
        request: { kind: "prepare_query", original_query: ORIGINAL, budget: BUDGET } });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CoreError);
    const closed = caught as CoreError;
    expect(closed.code).toBe("CONFLICT");
    expect(closed.subCode).toBe("RETRYABLE_BACKPRESSURE");
    expect(closed.details).not.toHaveProperty("execution");
    expect(closed.details).toEqual({ work: expect.objectContaining({
      native_work: 0, native_bytes: 0, logical_memory_bytes: expect.any(Number) }) });
    expect((closed.details as { work: { logical_memory_bytes: number } }).work.logical_memory_bytes)
      .toBeGreaterThanOrEqual(VECTOR_BACKING);
  } finally {
    await client?.close();
    const index = process.execArgv.lastIndexOf(GUARD);
    if (index !== -1) process.execArgv.splice(index, 1);
    if (!database.isClosed()) database.close();
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
