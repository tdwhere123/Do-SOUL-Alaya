import { describe, expect, it } from "vitest";
import type { EvidenceCapsule, MemoryEntry } from "../ontology/types.js";
import { createBackupMetadata, createPortableBundle } from "../operations/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("portable backup contract", () => {
  it("records backup metadata and an auditable no-mutation event", () => {
    const bundle = createPortableBundle({
      bundle_id: "bundle-1",
      created_at: now,
      created_by: "operator",
      profile_scope_id: "project:repo",
      ontology_records: [evidence(), memory()],
      source_refs: [{
        source_ref: "source-1",
        source_kind: "operator",
        target_object_ids: ["ev-1", "mem-1"],
        captured_at: now,
        summary: "operator-approved source"
      }],
      governance_audit: [],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: [],
        settings: {
          provider_profile: "local"
        }
      }]
    });

    const metadata = createBackupMetadata({
      backup_id: "backup-1",
      created_at: now,
      actor: "operator",
      reason: "manual backup before machine move",
      result: "created",
      source_bundle: bundle,
      storage: {
        driver: "node:sqlite",
        data_path_ref: "DATA_DIR:/tmp/alaya",
        database_state: "initialized"
      }
    });

    expect(metadata).toMatchObject({
      schema_version: 1,
      backup_id: "backup-1",
      source_bundle_id: "bundle-1",
      profile_scope_id: "project:repo",
      result: "created",
      storage: {
        driver: "node:sqlite",
        data_path_ref: "DATA_DIR:/tmp/alaya",
        database_state: "initialized"
      },
      integrity: bundle.integrity,
      audit_event: {
        event_kind: "operations.backup.created",
        actor: "operator",
        source_bundle_id: "bundle-1",
        result: "created",
        durable_truth_written: false
      }
    });
  });
});

function evidence(): EvidenceCapsule {
  return {
    object_id: "ev-1",
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: "operator",
    lifecycle_state: "active",
    evidence_kind: "user_statement",
    semantic_anchor: {
      topic: "portable backup",
      keywords: ["portable", "backup"],
      summary: "Evidence for a backup."
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "Operator confirmed the backup source.",
    excerpt: null,
    source_hash: "source-hash-1",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}

function memory(): MemoryEntry {
  return {
    object_id: "mem-1",
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: "operator",
    lifecycle_state: "active",
    dimension: "procedure",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Back up the memory bundle before moving machines.",
    domain_tags: ["operations"],
    evidence_refs: ["ev-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}
