import { afterEach, describe, expect, it, vi } from "vitest";
import { type MemoryEntry } from "@do-soul/alaya-protocol";
import { deriveFacetsFromText } from "../../recall/facet-keywords.js";
import { type SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { ReconciliationService } from "../../governance/reconciliation-service.js";
import { baseInput, createDeps, type DecideFn } from "./reconciliation-service.test-support.js";
import {
  closeReconciliationTestDatabases,
  createReconciliationMemoryRepo,
  seedReconciliationEntry as seedEntry
} from "./reconciliation-real-sqlite.test-support.js";

// Real-sqlite e2e: a reconciliation UPDATE that rewrites content must refresh the
// survivor row's facet_tags from the new content (flag on), and leave them
// untouched (flag off). Persistence is the real repo + real migrations; only the
// decider/keyword/event ports are stubbed (no real LLM exists in a unit context).

afterEach(closeReconciliationTestDatabases);

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
    const repo = await createReconciliationMemoryRepo();
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
    const repo = await createReconciliationMemoryRepo();
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
