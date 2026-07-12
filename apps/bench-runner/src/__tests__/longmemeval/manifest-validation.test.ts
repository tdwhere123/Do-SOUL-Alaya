import { describe, expect, it } from "vitest";
import { RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION } from "../../longmemeval/snapshot.js";
import { validateSnapshotManifest } from "../../longmemeval/snapshot/manifest-validation.js";

const FILE_PATH = "/tmp/snapshot.db.manifest.json";

function baseManifest(): Record<string, unknown> {
  return {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: "longmemeval_s",
    question_count: 1,
    recall_pipeline_version: "test",
    schema_migration_version: 1,
    bench_runner_version: "test",
    alaya_commit: "05d98df",
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-07-10T00:00:00.000Z",
    extraction_provenance: null
  };
}

describe("validateSnapshotManifest invalid payload rejection", () => {
  it("rejects non-object manifests", () => {
    expect(() => validateSnapshotManifest("not-an-object", FILE_PATH)).toThrow(
      /is not an object/u
    );
  });

  it("rejects artifact_integrity with invalid sha256 fields", () => {
    expect(() =>
      validateSnapshotManifest(
        {
          ...baseManifest(),
          artifact_integrity: {
            db_sha256: "not-a-sha",
            sidecar_sha256: "b".repeat(64)
          }
        },
        FILE_PATH
      )
    ).toThrow(/invalid artifact_integrity/u);
  });

  it("rejects attribution with unknown status", () => {
    expect(() =>
      validateSnapshotManifest(
        {
          ...baseManifest(),
          attribution: {
            status: "attributed-ish",
            gate_eligible: true
          }
        },
        FILE_PATH
      )
    ).toThrow(/invalid attribution/u);
  });
});
