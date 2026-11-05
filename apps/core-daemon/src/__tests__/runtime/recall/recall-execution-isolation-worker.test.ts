import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initDatabase, SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { conditionalRecallPayload, persistConditionalSource } from "../field/query-only-hydration-fixture.js";
import { seedWorkspace, seedRun } from "../field/source-field-harness.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";

it("keeps identical fixed-clock SQLite executions separate across worker preparation and restart", async () => {
  assertBuiltWorker();
  const root = mkdtempSync(join(tmpdir(), "alaya-execution-isolation-"));
  const database = initDatabase({ filename: join(root, "alaya.db") });
  let client: ReturnType<typeof createRecallReadWorkerClient> = null;
  try {
    seedWorkspace(database); seedRun(database);
    const source = (await persistConditionalSource(database, randomUUID(), "needle independent worker source")).source;
    database.close();
    const open = () => createRecallReadWorkerClient({ databaseFilename: database.filename,
      workerUrl: builtWorkerUrl, workerCount: 1, requestTimeoutMs: 20_000 });
    client = open();
    await client!.ready();
    const port = client!.conditionalFieldPort;
    const request = { ...conditionalRecallPayload("needle"), result_kind_view: "source_only" as const,
      budget: { ...conditionalRecallPayload("needle").budget, page_budget: 0 } };
    const a = await port.recall(request);
    const b = await port.recall(request);
    expect(a.index.query_id).toBe(b.index.query_id);
    expect(a.index.snapshot_id).toBe(b.index.snapshot_id);
    expect(a.index.continuation).not.toBeNull();
    expect(a.index.continuation?.continuation_id).not.toBe(b.index.continuation?.continuation_id);
    const acknowledge = (page: typeof a) => port.acknowledge!(page.preparation_id!, page.index, new Map(Object.entries(page.previews)));
    const receipt = await acknowledge(a);
    await acknowledge(b);
    expect(await acknowledge(a)).toEqual(receipt);
    const finish = { ...request, budget: { ...request.budget, page_budget: 100 } };
    const completeB = await port.recall({ ...finish, continuation: b.index.continuation });
    expect(completeB.index.entries.length).toBeGreaterThan(0);
    await acknowledge(completeB);
    const completeA = await port.recall({ ...finish, continuation: a.index.continuation });
    expect(completeA.index.entries).toEqual(completeB.index.entries);
    const competingA = await port.recall({ ...finish, continuation: a.index.continuation });
    const acknowledgments = await Promise.allSettled([acknowledge(completeA), acknowledge(competingA)]);
    expect(acknowledgments[0]?.status).toBe("fulfilled");
    expect(acknowledgments[1]).toMatchObject({ status: "rejected",
      reason: expect.objectContaining({ message: "stale prepared Recall delivery" }) });
    await port.discard!(competingA.preparation_id!);
    const replay = await port.recall({ ...finish, continuation: a.index.continuation });
    expect(replay.index.page_purpose).toBe("retry");
    expect(replay.issued_delivery_id).toBe(completeA.issued_delivery_id);
    await port.discard!(replay.preparation_id!);
    const short = await port.recall({ ...request,
      expires_at: new Date(Date.parse(request.lifetime_now) + 250).toISOString() });
    await acknowledge(short);
    // No old-token RPC drives cleanup: the child timer publishes route revocation.
    await new Promise(resolve => setTimeout(resolve, 400));
    await expect(acknowledge(short)).rejects.toThrow("Recall delivery worker unavailable");
    const revoked = await port.recall(request);
    await acknowledge(revoked);
    const writer = initDatabase({ filename: database.filename });
    try {
      new SqliteFieldEraseBarrierRepo(writer, fieldContractSha256).apply({ barrier_id: randomUUID(),
        workspace_id: request.workspace_id, generation_id: null, subject_kind: "source_record",
        subject_id: source.identity, erased_at: request.lifetime_now });
    } finally { writer.close(); }
    const withdrawn = await port.recall({ ...finish, continuation: revoked.index.continuation });
    expect(withdrawn.index.completeness.logical_index).toBe("invalidated");
    expect(withdrawn.index.entries).toEqual([]);
    await client!.close();
    client = open();
    await client!.ready();
    const restarted = await client!.conditionalFieldPort.recall({ ...finish, continuation: a.index.continuation });
    expect(restarted.index.completeness.logical_index).toBe("invalidated");
  } finally {
    await client?.close();
    if (!database.isClosed()) database.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
