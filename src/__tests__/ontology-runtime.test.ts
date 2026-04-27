import { afterEach, describe, expect, it } from "vitest";
import { createAlayaRuntime } from "../index.js";
import type { EvidenceCapsule, MemoryEntry } from "../index.js";
import { AuditedMutationExecutionError } from "../runtime/audit-types.js";
import { SqliteAlayaStorage } from "../storage/sqlite.js";
import { createTempDir, type TempDir } from "./helpers.js";

const now = "2026-04-27T00:00:00.000Z";

describe("ontology runtime operations", () => {
  const tempDirs: TempDir[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((entry) => entry.cleanup()));
  });

  it("creates evidence and a memory entry through audited runtime-owned writes", async () => {
    const temp = await createTempDir("alaya-ontology-success-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await runtime.createEvidenceCapsule({
        record: evidence("ev-1", "verified"),
        ...audit()
      });

      const result = await runtime.createMemoryEntry({
        record: memory("mem-1", ["ev-1"]),
        ...audit()
      });

      expect(result.committed).toBe(true);
      expect(result.result.object_id).toBe("mem-1");
    } finally {
      await runtime.close();
    }
  });

  it("rejects missing evidence refs after recording an auditable failed mutation", async () => {
    const temp = await createTempDir("alaya-ontology-auditable-reject-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    let mutationId = "";
    try {
      const rejection = await runtime.createMemoryEntry({
        record: memory("mem-missing", ["missing-evidence"]),
        ...audit()
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(AuditedMutationExecutionError);
      mutationId = (rejection as AuditedMutationExecutionError).mutationId;
    } finally {
      await runtime.close();
    }

    const storage = await SqliteAlayaStorage.open({ dataDir: temp.path });
    try {
      expect(storage.listAuditEventsForMutation(mutationId).map((event) => event.phase)).toEqual([
        "intent",
        "mutation_failed"
      ]);
    } finally {
      storage.close();
    }
  });

  it("does not let broken evidence support a new durable memory entry", async () => {
    const temp = await createTempDir("alaya-ontology-broken-evidence-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await runtime.createEvidenceCapsule({
        record: evidence("ev-broken", "broken"),
        ...audit()
      });

      await expect(runtime.createMemoryEntry({
        record: memory("mem-broken", ["ev-broken"]),
        ...audit()
      })).rejects.toBeInstanceOf(AuditedMutationExecutionError);
    } finally {
      await runtime.close();
    }
  });

  it("rejects synthesis and claim writes that try to bypass source object refs", async () => {
    const temp = await createTempDir("alaya-ontology-claim-source-");
    tempDirs.push(temp);
    const runtime = await createAlayaRuntime({ dataDir: temp.path });
    try {
      await runtime.createEvidenceCapsule({
        record: evidence("ev-claim", "verified"),
        ...audit()
      });

      await expect(runtime.createClaimForm({
        record: {
          object_id: "claim-1",
          object_kind: "claim_form",
          schema_version: 1,
          created_at: now,
          updated_at: now,
          created_by: "test",
          lifecycle_state: "draft",
          governance_subject: {
            subject_type: "memory",
            subject_ref: "missing-source"
          },
          claim_kind: "preference",
          scope_class: "project",
          enforcement_level: "preferred",
          origin_tier: "user_explicit",
          precedence_basis: "evidence_strength",
          proposition_digest: "claim digest",
          evidence_refs: ["ev-claim"],
          source_object_refs: ["missing-source"],
          workspace_id: "workspace-1",
          claim_status: "draft"
        },
        ...audit()
      })).rejects.toBeInstanceOf(AuditedMutationExecutionError);
    } finally {
      await runtime.close();
    }
  });
});

function audit() {
  return {
    source: {
      kind: "test",
      ref: "ontology-runtime.test"
    },
    evidence: [
      {
        kind: "test",
        ref: "ontology-runtime.test"
      }
    ],
    actor: "vitest"
  } as const;
}

function evidence(objectId: string, health: EvidenceCapsule["evidence_health_state"]): EvidenceCapsule {
  return {
    object_id: objectId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: "test",
    lifecycle_state: "active",
    evidence_kind: "user_statement",
    semantic_anchor: {
      topic: "task",
      keywords: ["memory"],
      summary: "operator supplied evidence"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: health,
    gist: "evidence gist",
    excerpt: null,
    source_hash: "hash-1",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}

function memory(objectId: string, evidenceRefs: readonly string[]): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: "test",
    lifecycle_state: "active",
    dimension: "preference",
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: "project",
    content: "Prefer audit-first durable writes.",
    domain_tags: ["runtime"],
    evidence_refs: evidenceRefs,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}
