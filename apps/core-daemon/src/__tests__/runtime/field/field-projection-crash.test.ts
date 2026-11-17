import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterAll(() => {
  expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]);
  isolation.strict.restore(); isolation.safe.restore();
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createAuditedSourceAdmission, fieldContractSha256 } from "@do-soul/alaya-core";
import { createDaemonFieldComposition } from "../../../runtime/field/field-composition.js";
import { startOwnedTestChild } from "../../support/owned-child-process.js";

it("recovers one projection after killing the writer before source audit, then retries the retained source", async () => {
  const root = mkdtempSync(join(tmpdir(), "field-crash-"));
  const filename = join(root, "alaya.sqlite");
  const workspace = "workspace-crash";
  const seed = initDatabase({ filename });
  seed.connection.prepare(`INSERT INTO workspaces(workspace_id, name, root_path, workspace_kind,
    workspace_state, created_at) VALUES (?, ?, ?, 'local_repo', 'active', ?)`)
    .run(workspace, "Crash fixture", root, "2026-08-16T00:00:00.000Z");
  seed.close();
  const repo = fileURLToPath(new URL("../../../../../../", import.meta.url));
  // Load the standalone JS config directly. Bundling its imports would probe
  // Windows mapped drives before the config's preserveSymlinks can take effect.
  const child = startOwnedTestChild([join(repo, "node_modules/vitest/vitest.mjs"), "run", "--configLoader=native", "--config",
    fileURLToPath(new URL("./projection-recovery.vitest.config.mjs", import.meta.url))],
    AbortSignal.timeout(45_000), { cwd: repo, env: { ...process.env, ALAYA_FIELD_CRASH_DATABASE: filename } });
  let database: ReturnType<typeof initDatabase> | undefined;
  try {
    await child.waitForStdout("FIELD_STATE_AND_INTENT_COMMITTED");
    const terminated = await child.stop();
    expect(terminated.signal).toBe("SIGKILL");
    database = initDatabase({ filename });
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_records").get()).toEqual({ n: 1 });
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM field_projection_rebuild_requests").get()).toEqual({ n: 1 });
    const eventLogRepo = new SqliteEventLogRepo(database);
    const field = createDaemonFieldComposition({ database, eventLogRepo, fieldProjectionAdmissionMode: "explicit_checkpoint" });
    expect(field.fieldRepos.generations.readActive(workspace)?.status).toBe("active");
    expect(database.connection.prepare("SELECT COUNT(*) AS n FROM field_projection_rebuild_requests").get()).toEqual({ n: 0 });
    const record = field.stores.listStoredRecords(workspace)[0]!;
    expect(record.content_bytes).toBe("Retained source.");
    expect(await eventLogRepo.queryByEntity("source_record", record.record.identity)).toEqual([]);
    await createAuditedSourceAdmission({ stores: field.stores, eventLogRepo, sha256: fieldContractSha256,
      runtimeNotifier: { notifyEntry: () => undefined } }).admit({
      ...record.record, content_bytes: record.content_bytes, spans: []
    }, { workspaceId: workspace });
    await field.fieldProjectionCheckpoint.refresh();
    expect(await eventLogRepo.queryByEntity("source_record", record.record.identity)).toHaveLength(1);
    createDaemonFieldComposition({ database, eventLogRepo });
    expect(database.connection.prepare(`SELECT COUNT(*) AS n FROM event_log
      WHERE event_type = 'soul.field.generation.activated'`).get()).toEqual({ n: 1 });
    expect(field.stores.listRecords(workspace)).toHaveLength(1);
  } finally {
    await child.stop(); database?.close(); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
