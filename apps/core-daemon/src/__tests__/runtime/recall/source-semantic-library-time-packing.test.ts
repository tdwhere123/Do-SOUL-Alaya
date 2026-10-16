import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { indexEntryCacheKey } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, encodeSourceSemanticLibraryResponse, fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";

const CLOCK = "2026-09-18T00:00:00.000Z";
const SOURCE_TIME = "2024-02-03T04:05:06.0000007Z";
// Protocol v2 includes the actual preparation/acquisition receipt in each delivery.
const OUTPUT_BYTES = 20_300;

it("reserves all five source facts before adding optional time to a bounded native page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-time-packing-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      sha256: fieldContractSha256
    });
    for (let item = 1; item <= 5; item++) {
      await admission.admit({ workspace_id: WS, source_id: `item-cost-${item}`, source_version: "1",
        content_bytes: `User: Item ${item} costs ${item * 10} dollars.`, evidence_object_id: null,
        recorded_at: CLOCK, event_time: SOURCE_TIME, valid_from: null, valid_to: null,
        speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    }
  } finally { database.close(); closeCachedDatabase(filename); }

  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
  try {
    await client.ready();
    const request = { workspace_id: WS, as_of: CLOCK,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: {
        kind: "recall", accepts_unreviewed_conditional_results: true,
        original_query: "What is the total cost of items 1 through 5?", semantic_correspondences: [],
        budget: { schema_version: 1, work_units: 200000, memory_bytes: 20000000,
          page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 },
        output_byte_limit: OUTPUT_BYTES
      } } as const;
    const worker = await client.sourceSemanticsPort!.execute(request);
    if (worker.kind !== "recall") throw new Error("library recall expected");
    const delivered = encodeSourceSemanticLibraryResponse(worker);
    if (delivered.operation !== "recall" || delivered.results === undefined
      || delivered.index === undefined || delivered.source_disclosures === undefined) {
      throw new Error("public library delivery expected");
    }
    expect(delivered.results.map(row => row.content_preview).sort()).toEqual([1, 2, 3, 4, 5]
      .map(item => `User: Item ${item} costs ${item * 10} dollars.`));
    expect(delivered.index.continuation).toBeNull();
    expect(delivered.results.every(row => row.budget_state.within_budget)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(delivered))).toBeLessThanOrEqual(OUTPUT_BYTES);
    expect(delivered.results.filter(row => row.source_disclosure?.source_time?.kind === "known")).toHaveLength(4);
    const undisclosed = delivered.results[4]!;
    expect(undisclosed.source_disclosure?.source_time).toBeUndefined();
    expect(delivered.source_disclosures[indexEntryCacheKey(delivered.index.entries[4]!)]?.source_time).toBeUndefined();
    expect(delivered.results[0]?.source_disclosure?.source_time).toEqual({ kind: "known", at: SOURCE_TIME });

    const roomy = await client.sourceSemanticsPort!.execute({ ...request,
      request: { ...request.request, output_byte_limit: 1_000_000 } });
    if (roomy.kind !== "recall") throw new Error("roomy library recall expected");
    const roomyDelivery = encodeSourceSemanticLibraryResponse(roomy);
    if (roomyDelivery.operation !== "recall" || roomyDelivery.results === undefined || roomyDelivery.index === undefined) {
      throw new Error("roomy public library delivery expected");
    }
    expect(roomyDelivery.results.map(row => row.content_preview)).toEqual(delivered.results.map(row => row.content_preview));
    expect(roomyDelivery.index.continuation).toBeNull();
    expect(roomyDelivery.results.every(row => row.source_disclosure?.source_time?.kind === "known")).toBe(true);
    expect(worker.work.logical_work).toBe(roomy.work.logical_work);
    expect(worker.work.logical_memory_bytes).toBe(roomy.work.logical_memory_bytes);
    const constrained = await client.sourceSemanticsPort!.execute({ ...request, request: { ...request.request,
      budget: { ...request.request.budget, work_units: 20_000, memory_bytes: 1_500_000 } } });
    if (constrained.kind !== "recall") throw new Error("constrained library recall expected");
    const constrainedDelivery = encodeSourceSemanticLibraryResponse(constrained);
    if (constrainedDelivery.operation !== "recall" || constrainedDelivery.results === undefined
      || constrainedDelivery.index === undefined) throw new Error("constrained public library delivery expected");
    expect(constrainedDelivery.results.map(row => row.content_preview)).toEqual(delivered.results.map(row => row.content_preview));
    expect(constrainedDelivery.index.continuation).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(constrainedDelivery))).toBeLessThanOrEqual(OUTPUT_BYTES);
    expect(constrained.work.logical_work).toBeLessThanOrEqual(20_000);
    expect(constrained.work.logical_memory_bytes).toBeLessThanOrEqual(1_500_000);
  } finally {
    await client.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
  }
}, 60000);
