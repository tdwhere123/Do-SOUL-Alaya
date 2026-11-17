import { it, vi } from "vitest";
await vi.hoisted(async () => {
  const { installStrictProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/strict-provider-free-boundary.js");
  installStrictProviderFreeBoundary();
});
import { writeSync } from "node:fs";
import { createAuditedSourceAdmission, fieldContractSha256 } from "@do-soul/alaya-core";
import { initDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../../runtime/field/field-composition.js";

it("pauses after source and repair intent commit, before independent source audit", async () => {
  const filename = process.env.ALAYA_FIELD_CRASH_DATABASE;
  if (filename === undefined) throw new Error("isolated database required");
  const database = initDatabase({ filename });
  const field = createDaemonFieldComposition({ database, eventLogRepo: new SqliteEventLogRepo(database),
    fieldProjectionAdmissionMode: "explicit_checkpoint" });
  await createAuditedSourceAdmission({ stores: field.stores, sha256: fieldContractSha256,
    runtimeNotifier: { notifyEntry: () => undefined }, eventLogRepo: { append() {
      writeSync(1, "FIELD_STATE_AND_INTENT_COMMITTED\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error("crash fixture unexpectedly resumed");
    } } }).admit({ workspace_id: "workspace-crash", source_id: "source-crash", source_version: "1",
      content_bytes: "Retained source.", evidence_object_id: null, recorded_at: "2026-08-16T00:00:00.000Z",
      event_time: null, valid_from: null, valid_to: null, spans: [] }, { workspaceId: "workspace-crash" });
});
