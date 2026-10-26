import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { SourceIndexAcquisition, fieldContractSha256 } from "@do-soul/alaya-core";
import { hashContentDigest } from "@do-soul/alaya-protocol";
import { SemanticChainConfigSchema } from "../../../runs/recall-measurement/contract.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";
import { publishIndexedGeneration } from "../../../../../core-daemon/src/__tests__/runtime/recall/recall-storage.test-support.js";
import { SIMULATED_CONFIGURATION } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-index-acquisition.test-support.js";
import { nativeRecallFixture } from "./native-recall.test-support.js";

/** Derive a separately bound, indexed snapshot without mutating the replay's
 * sealed SQLite input or relabelling its historical admission. */
export async function ordinaryIndexedSnapshot(sourceText: readonly string[]) {
  const native = await nativeRecallFixture(sourceText), plan = native.admitted.plan;
  const snapshot = join(native.root, "ordinary-indexed.sqlite");
  copyFileSync(plan.config.snapshot_path, snapshot);
  const database = initDatabase({ filename: snapshot });
  try {
    // These authored vectors are a provider-free simulation. A full-source
    // window keeps this fixture about public pagination, not vector windowing.
    await publishIndexedGeneration(database, sourceText.map(text => ({ text })), {
      ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, window_bytes: 16384 }
    }, plan.config.workspace_id);
    database.connection.pragma("wal_checkpoint(TRUNCATE)");
    database.connection.pragma("journal_mode = DELETE");
  } finally { database.close({ optimize: false }); }
  expect(hashRegularFileNoFollow(plan.config.snapshot_path)).toBe(plan.config.snapshot_sha256);
  const config = SemanticChainConfigSchema.parse({ ...plan.config,
    snapshot_path: snapshot, snapshot_sha256: hashRegularFileNoFollow(snapshot) });
  return { root: native.root, config, queries: plan.queries, native };
}

/** Only embedding preparation is simulated; the selected generation, bounded
 * acquisition, worker, MCP, acknowledgment and archive paths remain real. */
export function simulateIndexedQueryPreparation() {
  const prepare = SourceIndexAcquisition.prepareQuery;
  return vi.spyOn(SourceIndexAcquisition, "prepareQuery").mockImplementation(options => {
    const selection = options.selection;
    if (selection === null) return prepare(options);
    return prepare({ ...options, bind: async () => ({ status: "ready", profile: selection.configuration.profile,
      profile_id: selection.profile_id, embedInputs: async inputs => inputs.map(item => ({
        status: "embedded", input_id: item.input_id, input_digest: hashContentDigest(item.text, fieldContractSha256),
        vector: new Float32Array([0, 1, 0]), token_count: 2, truncated: false })) }) });
  });
}
