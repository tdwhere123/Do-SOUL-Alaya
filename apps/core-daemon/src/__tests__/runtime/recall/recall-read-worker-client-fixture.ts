import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SynthesisStatus } from "@do-soul/alaya-protocol";

export const builtWorkerUrl = new URL(
  "../../../../dist/runtime/recall/recall-read-worker.js",
  import.meta.url
);

export function assertBuiltWorker(): void {
  if (!existsSync(fileURLToPath(builtWorkerUrl))) {
    throw new Error("Built recall-read-worker dist missing. Run `pnpm build` before this test.");
  }
}

export function createMemoryEntry(overrides: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly content: string;
  readonly activation_score: number;
  readonly evidence_refs?: readonly string[];
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "memory_entry" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    dimension: "procedure" as const,
    source_kind: "user" as const,
    formation_kind: "explicit" as const,
    scope_class: "project" as const,
    content: overrides.content,
    domain_tags: ["recall"],
    evidence_refs: overrides.evidence_refs ?? [],
    workspace_id: overrides.workspace_id,
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot" as const,
    activation_score: overrides.activation_score,
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

export function createSynthesisCapsule(overrides: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "synthesis_capsule" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    topic_key: "recall/worker",
    synthesis_type: "phase_synthesis" as const,
    summary: `Synthesis for ${overrides.workspace_id}`,
    evidence_refs: [],
    source_memory_refs: [],
    workspace_id: overrides.workspace_id,
    run_id: overrides.run_id,
    synthesis_status: SynthesisStatus.WORKING
  };
}

export function createEvidenceCapsule(overrides: {
  readonly object_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly artifact_ref: string;
}) {
  return {
    object_id: overrides.object_id,
    object_kind: "evidence_capsule" as const,
    schema_version: 1,
    lifecycle_state: "active" as const,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    created_by: "test",
    evidence_kind: "tool_output" as const,
    semantic_anchor: { topic: "worker", keywords: [], summary: "worker anchor" },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: overrides.artifact_ref
    },
    evidence_health_state: "verified" as const,
    gist: "worker evidence",
    excerpt: "worker evidence excerpt",
    source_hash: null,
    run_id: overrides.run_id,
    workspace_id: overrides.workspace_id,
    surface_id: null
  };
}
