import { describe, expect, it } from "vitest";
import type { AuditedMutationRecord } from "../runtime/audit-types.js";
import type { EvidenceCapsule, MemoryEntry } from "../ontology/types.js";
import {
  createPortableBundle,
  validatePortableBundleForImport
} from "../operations/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("portable bundle manifest", () => {
  it("creates a deterministic manifest snapshot and excludes runtime artifacts", () => {
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
      governance_audit: [auditRecord()],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: ["audit-1"],
        settings: {
          provider_profile: "local"
        }
      }],
      runtime_artifacts: [{
        artifact_id: "pack-1",
        artifact_kind: "context_pack",
        reason: "runtime projection is not durable truth"
      }]
    });

    expect(bundle.manifest).toMatchObject({
      manifest_version: 1,
      schema_version: 1,
      bundle_id: "bundle-1",
      created_at: now,
      profile_scope_id: "project:repo",
      counts: {
        ontology_records: 2,
        evidence_capsules: 1,
        memory_entries: 1,
        synthesis_capsules: 0,
        claim_forms: 0,
        governance_audit_records: 1,
        profile_scopes: 1
      },
      ontology_object_ids: ["ev-1", "mem-1"],
      evidence_object_ids: ["ev-1"],
      governance_audit_event_ids: ["audit-1"],
      source_refs: ["source-1"],
      profile_scope_ids: ["project:repo"],
      excluded_runtime_artifact_count: 1,
      payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(bundle.payload).not.toHaveProperty("runtime_artifacts");
    expect(bundle.payload.ontology_records.map((record) => record.object_kind)).toEqual([
      "evidence_capsule",
      "memory_entry"
    ]);
    expect(validatePortableBundleForImport(bundle).manifest).toEqual(bundle.manifest);
  });

  it("rejects profile scope settings that would export raw secret values", () => {
    expect(() => createPortableBundle({
      bundle_id: "bundle-secret",
      created_at: now,
      created_by: "operator",
      profile_scope_id: "project:repo",
      ontology_records: [evidence(), memory()],
      source_refs: [{
        source_ref: "source-1",
        source_kind: "operator",
        target_object_ids: ["ev-1", "mem-1"],
        captured_at: now,
        summary: null
      }],
      governance_audit: [auditRecord()],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: ["audit-1"],
        settings: {
          provider_api_key: "sk-test-should-not-export"
        }
      }]
    })).toThrow(/secret-bearing key/);

    expect(() => createPortableBundle({
      bundle_id: "bundle-secret-string",
      created_at: now,
      created_by: "operator",
      profile_scope_id: "project:repo",
      ontology_records: [evidence(), memory()],
      source_refs: [{
        source_ref: "source-1",
        source_kind: "operator",
        target_object_ids: ["ev-1", "mem-1"],
        captured_at: now,
        summary: null
      }],
      governance_audit: [auditRecord()],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: ["audit-1"],
        settings: {
          provider_secret_ref: "env:OPENAI_API_KEY",
          provider_note: "Authorization: Bearer raw-secret"
        }
      }]
    })).toThrow(/secret values/);
  });

  it("rejects governance audit targets missing from the portable payload", () => {
    expect(() => createPortableBundle({
      bundle_id: "bundle-missing-target",
      created_at: now,
      created_by: "operator",
      profile_scope_id: "project:repo",
      ontology_records: [evidence(), memory()],
      source_refs: [{
        source_ref: "source-1",
        source_kind: "operator",
        target_object_ids: ["ev-1", "mem-1"],
        captured_at: now,
        summary: null
      }],
      governance_audit: [auditRecord({
        target: {
          type: "memory_entry",
          id: "mem-missing"
        }
      })],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: ["audit-1"],
        settings: {}
      }]
    })).toThrow(/target mem-missing not found/);

    expect(() => createPortableBundle({
      bundle_id: "bundle-missing-visibility-target",
      created_at: now,
      created_by: "operator",
      profile_scope_id: "project:repo",
      ontology_records: [evidence(), memory()],
      source_refs: [{
        source_ref: "source-1",
        source_kind: "operator",
        target_object_ids: ["ev-1", "mem-1"],
        captured_at: now,
        summary: null
      }],
      governance_audit: [auditRecord({
        target: {
          type: "memory_visibility",
          id: "mem-missing"
        }
      })],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: ["audit-1"],
        settings: {}
      }]
    })).toThrow(/target mem-missing not found/);

    expect(() => createPortableBundle({
      bundle_id: "bundle-missing-promotion-target",
      created_at: now,
      created_by: "operator",
      profile_scope_id: "project:repo",
      ontology_records: [evidence(), memory()],
      source_refs: [{
        source_ref: "source-1",
        source_kind: "operator",
        target_object_ids: ["ev-1", "mem-1"],
        captured_at: now,
        summary: null
      }],
      governance_audit: [auditRecord({
        target: {
          type: "promotion_candidate",
          id: "mem-missing"
        }
      })],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: ["audit-1"],
        settings: {}
      }]
    })).toThrow(/target mem-missing not found/);

    expect(() => createPortableBundle({
      bundle_id: "bundle-runtime-artifact-target",
      created_at: now,
      created_by: "operator",
      profile_scope_id: "project:repo",
      ontology_records: [evidence(), memory()],
      source_refs: [{
        source_ref: "source-1",
        source_kind: "operator",
        target_object_ids: ["ev-1", "mem-1"],
        captured_at: now,
        summary: null
      }],
      governance_audit: [auditRecord({
        target: {
          type: "context_pack",
          id: "pack-1"
        }
      })],
      profile_scopes: [{
        scope_id: "project:repo",
        scope_kind: "project",
        source_ref: "source-1",
        evidence_refs: ["ev-1"],
        governance_audit_refs: ["audit-1"],
        settings: {}
      }]
    })).toThrow(/target type context_pack is not portable/);
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
      topic: "portable bundle",
      keywords: ["portable", "evidence"],
      summary: "Evidence for a portable memory."
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "Operator confirmed the memory.",
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
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Use portable bundles for machine moves.",
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

function auditRecord(overrides: Partial<AuditedMutationRecord> = {}): AuditedMutationRecord {
  return {
    auditEventId: "audit-1",
    mutationId: "mutation-1",
    phase: "committed",
    status: "committed",
    mutationKind: "runtime.create_memory_entry",
    source: {
      kind: "operator",
      ref: "source-1"
    },
    evidence: [{
      kind: "evidence_capsule",
      ref: "ev-1"
    }],
    actor: "operator",
    target: {
      type: "memory_entry",
      id: "mem-1"
    },
    payload: {
      profile_scope: "project:repo"
    },
    createdAt: now,
    ...overrides
  };
}
