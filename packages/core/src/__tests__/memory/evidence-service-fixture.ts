import { EvidenceHealthState, type EvidenceCapsule, type EventLogEntry } from
  "@do-soul/alaya-protocol";
import { vi, type Mock } from "vitest";
import {
  EvidenceService,
  type EvidenceCapsuleInput,
  type EvidenceServiceDependencies,
  type EvidenceServiceEvidenceCapsuleRepoPort
} from "../../memory/evidence-service.js";

export function createEvidenceInput(
  overrides: Partial<EvidenceCapsuleInput> = {}
): EvidenceCapsuleInput {
  return {
    created_by: "user_action",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "build",
      keywords: ["pnpm", "build"],
      summary: "Build output"
    },
    event_anchor: {
      event_type: "engine.response.received",
      event_id: "evt_1",
      occurred_at: "2026-03-20T00:00:00.000Z"
    },
    physical_anchor: {
      file_path: "packages/core/src/memory/evidence-service.ts",
      line_range: { start: 1, end: 20 },
      symbol_name: "EvidenceService",
      artifact_ref: null
    },
    evidence_health_state: EvidenceHealthState.VERIFIED,
    gist: "Evidence gist",
    excerpt: "Evidence excerpt",
    source_hash: "sha256:abc",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null,
    ...overrides
  };
}

export function createStoredEvidence(
  overrides: Partial<EvidenceCapsule> = {}
): EvidenceCapsule {
  return Object.freeze({
    object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "user_action",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "build",
      keywords: ["pnpm", "build"],
      summary: "Build output"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: EvidenceHealthState.VERIFIED,
    gist: "Evidence gist",
    excerpt: "Evidence excerpt",
    source_hash: "sha256:abc",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null,
    ...overrides
  });
}

export function createCreationHarness(
  dependencies: Partial<EvidenceServiceDependencies> & {
    readonly deleteById?: Mock<(objectId: string) => Promise<void>>;
  } = {}
) {
  const store = new Map<string, EvidenceCapsule>();
  const create = vi.fn<NonNullable<EvidenceServiceEvidenceCapsuleRepoPort["createInCurrentTransaction"]>>((capsule) => {
    const frozen = Object.freeze({ ...capsule });
    store.set(capsule.object_id, frozen);
    return frozen;
  });
  const append = vi.fn((
    event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ) => ({
    ...event,
    event_id: "event-create",
    created_at: "2026-03-20T01:00:00.000Z",
    revision: 0
  }));
  const { deleteById, generateObjectId, ...serviceDependencies } = dependencies;
  const service = new EvidenceService({
    now: () => "2026-03-20T01:00:00.000Z",
    generateObjectId: generateObjectId ?? (() => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"),
    eventLogRepo: { append, transactional: <T>(fn: () => T) => fn() },
    ...serviceDependencies,
    evidenceCapsuleRepo: {
      create: create as unknown as EvidenceServiceEvidenceCapsuleRepoPort["create"],
      createInCurrentTransaction: create,
      deleteById: deleteById ?? vi.fn(),
      findById: vi.fn(async (objectId: string) => store.get(objectId) ?? null),
      findByRunId: vi.fn(async () => []),
      findByWorkspaceId: vi.fn(async () => []),
      findByHealth: vi.fn(async () => []),
      updateHealth: vi.fn(async () => {
        throw new Error("not used");
      }),
      updateHealthInCurrentTransaction: vi.fn(() => {
        throw new Error("not used");
      })
    },
    runtimeNotifier: { notifyEntry: vi.fn() }
  });
  return { service, create, append };
}
