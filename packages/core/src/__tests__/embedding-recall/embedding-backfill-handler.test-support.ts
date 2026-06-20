import { createHash } from "node:crypto";
import { vi } from "vitest";
import { MemoryDimension, ScopeClass, type MemoryEntry } from "@do-soul/alaya-protocol";
import { type EmbeddingBackfillMetadata } from "../../embedding-recall/embedding-backfill-handler.js";
import type { TestMock } from "../shared/mock-types.js";

export // Mirrors hashMemoryContent in ../../embedding-recall/embedding-backfill-handler.ts so the test can
// model the write-time content-hash guard's live re-check.
function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function createProvider(overrides: {
  readonly isAvailable?: boolean;
  readonly embedTexts?: TestMock;
} = {}) {
  return {
    providerKind: "openai",
    modelId: "text-embedding-3-small",
    schemaVersion: 1,
    isAvailable: overrides.isAvailable ?? true,
    embedTexts:
      overrides.embedTexts ??
      vi.fn(async (texts: readonly string[]) => texts.map(() => new Float32Array([1, 0, 0])))
  };
}

export function createEmbeddingMetadata(
  overrides: Partial<EmbeddingBackfillMetadata>
): EmbeddingBackfillMetadata {
  return {
    object_id: overrides.object_id ?? "memory-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    content_hash: overrides.content_hash ?? "sha256:memory-1",
    provider_kind: overrides.provider_kind ?? "openai",
    model_id: overrides.model_id ?? "text-embedding-3-small",
    schema_version: overrides.schema_version ?? 1,
    dimensions: overrides.dimensions ?? 3,
    created_at: overrides.created_at ?? "2026-04-23T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:00:00.000Z"
  };
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: overrides.object_id ?? "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    created_by: "system",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: overrides.scope_class ?? ScopeClass.PROJECT,
    content: overrides.content ?? "Embedding handler memory content.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: overrides.activation_score ?? 0.6,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}
