import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  deriveFacetsFromText,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import { ReconciliationService } from "../../governance/reconciliation-service.js";
import { baseInput, createDeps, type DecideFn } from "./reconciliation-service.test-support.js";

// Real-sqlite e2e: a reconciliation UPDATE that rewrites content must refresh the
// survivor row's facet_tags from the new content (flag on), and leave them
// untouched (flag off). Persistence is the real repo + real migrations; only the
// decider/keyword/event ports are stubbed (no real LLM exists in a unit context).

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

async function createMemoryRepo(): Promise<SqliteMemoryEntryRepo> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  return new SqliteMemoryEntryRepo(database);
}

function seedEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "11111111-1111-4111-8111-111111111111",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "The user works at a firm in Berlin.",
    domain_tags: ["residence"],
    evidence_refs: ["evidence-old"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
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
    superseded_by: null,
    forget_disposition: null,
    forget_disposition_ref: null,
    ...overrides
  };
}

function wireUpdateService(repo: SqliteMemoryEntryRepo, seeded: MemoryEntry): ReconciliationService {
  const { deps } = createDeps([seeded], {
    thresholds: { similarityFloor: 0.2 },
    memoryRepo: { findByIds: (workspaceId, ids) => repo.findByIds(workspaceId, ids) },
    memoryUpdate: {
      update: async (objectId, fields) =>
        repo.update(objectId, { ...fields, updated_at: "2026-06-29T00:00:00.000Z" })
    }
  });
  deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
    kind: "update",
    targetObjectId: seeded.object_id,
    reason: "refines the fact"
  }));
  return new ReconciliationService(deps);
}

const applyUpdateVerdict = async (verdict: { readonly kind: string }) =>
  verdict.kind === "noop" ? {} : { incomingEvidenceRef: "evidence-new" };

describe("reconciliation UPDATE facet_tags refresh", () => {
  it("refreshes facet_tags from the rewritten content when provided", async () => {
    const repo = await createMemoryRepo();
    const seeded = seedEntry({ facet_tags: null });
    await repo.create(seeded);

    const newContent = "The user works at a company in Berlin and likes spicy food.";
    const incomingFacetTags = deriveFacetsFromText(newContent).map((facet) => ({ facet }));
    expect(incomingFacetTags.map((tag) => tag.facet)).toContain("preference_like");

    const service = wireUpdateService(repo, seeded);
    const decision = await service.runWithDecision(
      { ...baseInput, incomingContent: newContent, incomingDomainTags: ["residence"], incomingFacetTags },
      applyUpdateVerdict
    );

    expect(decision.kind).toBe("update");
    const row = (await repo.findByIds("workspace-1", [seeded.object_id]))[0]!;
    expect(row.content).toBe(newContent);
    expect((row.facet_tags ?? []).map((tag) => tag.facet)).toEqual(
      incomingFacetTags.map((tag) => tag.facet)
    );
  });

  it("leaves facet_tags untouched when no incomingFacetTags is supplied (flag off)", async () => {
    const repo = await createMemoryRepo();
    const seeded = seedEntry({ facet_tags: [{ facet: "location_place" }] });
    await repo.create(seeded);

    const newContent = "The user works at a company in Berlin and likes spicy food.";
    const service = wireUpdateService(repo, seeded);
    const decision = await service.runWithDecision(
      { ...baseInput, incomingContent: newContent, incomingDomainTags: ["residence"] },
      applyUpdateVerdict
    );

    expect(decision.kind).toBe("update");
    const row = (await repo.findByIds("workspace-1", [seeded.object_id]))[0]!;
    expect(row.content).toBe(newContent);
    expect((row.facet_tags ?? []).map((tag) => tag.facet)).toEqual(["location_place"]);
  });
});
