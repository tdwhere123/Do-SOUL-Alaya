import { describe, expect, it } from "vitest";
import type { AuditedMutationRecord } from "../runtime/audit-types.js";
import type { EvidenceCapsule, MemoryEntry } from "../ontology/types.js";
import {
  createPortableBundle,
  hashPortablePayload,
  validatePortableBundleForImport
} from "../operations/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("import/export bundle integrity", () => {
  it("rejects durable memory exports that are missing required evidence", () => {
    expect(() => createPortableBundle({
      ...bundleInput(),
      ontology_records: [memory("missing-ev")]
    })).toThrow(/Evidence reference missing-ev not found/);
  });

  it("preserves governance audit records through import validation", () => {
    const bundle = createPortableBundle(bundleInput());
    const validated = validatePortableBundleForImport(bundle);

    expect(validated.payload.governance_audit).toEqual([auditRecord()]);
    expect(validated.payload.governance_audit[0]?.payload).toMatchObject({
      profile_scope: "project:repo",
      governance_receipt: {
        actor: "operator",
        reason: "approved portable import"
      }
    });
  });

  it("rejects version mismatch and corrupt bundle payloads", () => {
    const bundle = createPortableBundle(bundleInput());

    expect(() => validatePortableBundleForImport({
      ...bundle,
      schema_version: 2
    })).toThrow(/Unsupported portable bundle schema version/);

    expect(() => validatePortableBundleForImport({
      ...bundle,
      payload: {
        ...bundle.payload,
        ontology_records: [
          evidence(),
          {
            ...memory("ev-1"),
            content: "tampered after export"
          }
        ]
      }
    })).toThrow(/Portable bundle integrity check failed/);
  });

  it("rejects forged runtime projections in durable ontology records", () => {
    const bundle = createPortableBundle(bundleInput());
    const forgedPayload = {
      ...bundle.payload,
      ontology_records: [
        evidence(),
        {
          runtime_id: "projection-1",
          object_kind: "working_projection",
          task_surface_ref: "task-1",
          expires_at: now,
          derived_from: "mem-1",
          retention_policy: "session_only"
        }
      ]
    };
    const payloadSha256 = hashPortablePayload(forgedPayload as never);

    expect(() => validatePortableBundleForImport({
      ...bundle,
      payload: forgedPayload as never,
      integrity: {
        ...bundle.integrity,
        payload_sha256: payloadSha256
      },
      manifest: {
        ...bundle.manifest,
        payload_sha256: payloadSha256
      }
    })).toThrow(/Runtime artifact working_projection cannot be imported as durable truth/);
  });
});

function bundleInput() {
  return {
    bundle_id: "bundle-1",
    created_at: now,
    created_by: "operator",
    profile_scope_id: "project:repo",
    ontology_records: [evidence(), memory("ev-1")],
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
      scope_kind: "project" as const,
      source_ref: "source-1",
      evidence_refs: ["ev-1"],
      governance_audit_refs: ["audit-1"],
      settings: {
        provider_profile: "local"
      }
    }]
  };
}

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

function memory(evidenceRef: string): MemoryEntry {
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
    evidence_refs: [evidenceRef],
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

function auditRecord(): AuditedMutationRecord {
  return {
    auditEventId: "audit-1",
    mutationId: "mutation-1",
    phase: "committed",
    status: "committed",
    mutationKind: "runtime.evaluate_governance_action",
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
      profile_scope: "project:repo",
      governance_receipt: {
        actor: "operator",
        reason: "approved portable import"
      }
    },
    createdAt: now
  };
}
