import { describe, expect, it } from "vitest";
import { RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION } from "../../../longmemeval/snapshot/materialize.js";
import { validateSnapshotManifest } from "../../../longmemeval/snapshot/manifest-validation.js";

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

  it("rejects an invalid persisted seed extraction path", () => {
    expect(() => validateSnapshotManifest({
      ...baseManifest(),
      seed_extraction_path: {
        path: "official_api_compile",
        cache_hits: -1
      }
    }, FILE_PATH)).toThrow(/invalid seed_extraction_path/u);
  });

  it("keeps an old snapshot without seed extraction evidence diagnostic-only", () => {
    expect(validateSnapshotManifest(baseManifest(), FILE_PATH).attribution).toEqual({
      status: "legacy_unattributed",
      gate_eligible: false
    });
  });

  it("rejects a gate-eligible claim without seed extraction evidence", () => {
    expect(() => validateSnapshotManifest({
      ...baseManifest(),
      attribution: {
        status: "legacy_unattributed",
        gate_eligible: true
      }
    }, FILE_PATH)).toThrow(/overclaims gate eligibility/u);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid schema migration version %s",
    (schemaMigrationVersion) => {
      expect(() => validateSnapshotManifest({
        ...baseManifest(),
        schema_migration_version: schemaMigrationVersion
      }, FILE_PATH)).toThrow(/schema_migration_version/u);
    }
  );
});
