import { afterEach, describe, expect, it, vi } from "vitest";
import { type MemoryEntry } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, type SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { ReconciliationService } from "../../governance/reconciliation/reconciliation-service.js";
import { authorizedDurableRewrite, baseInput, createDeps, type DecideFn } from "./reconciliation-service.test-support.js";
import {
  closeReconciliationTestDatabases,
  createReconciliationMemoryRepo,
  createReconciliationSqliteHarness,
  seedReconciliationEntry as seedEntry
} from "./reconciliation-real-sqlite.test-support.js";

const UPDATED_AT = "2026-06-30T00:00:00.000Z";

afterEach(closeReconciliationTestDatabases);

function wireRepoDeps(
  repo: SqliteMemoryEntryRepo,
  neighbors: readonly MemoryEntry[],
  overrides: Parameters<typeof createDeps>[1] = {}
) {
  return createDeps([...neighbors], {
    memoryRepo: { findByIds: (workspaceId, ids) => repo.findByIds(workspaceId, ids) },
    memoryUpdate: {
      update: async (objectId, fields) => repo.update(objectId, { ...fields, updated_at: UPDATED_AT })
    },
    ...overrides
  });
}

const applyUpdateVerdict = async (verdict: { readonly kind: string }) =>
  verdict.kind === "noop" ? {} : { incomingEvidenceRef: "evidence-new" };

describe("reconciliation canonical_entities survivor persistence", () => {
  it("persists canonical_entities on an ADD survivor (created via the router applyVerdict)", async () => {
    const repo = await createReconciliationMemoryRepo();
    // No neighbor -> ADD with no LLM. The router's applyVerdict creates the row;
    // canonical_entities are sourced from the signal via buildMemoryInput.
    const { deps } = wireRepoDeps(repo, []);
    const service = new ReconciliationService(deps);
    const addedId = "22222222-2222-4222-8222-222222222222";

    const decision = await service.runWithDecision(
      {
        ...baseInput,
        incomingContent: "Alice lives in Berlin.",
        incomingDomainTags: ["residence"],
        incomingProjectionFields: { canonical_entities: ["alice", "berlin"] }
      },
      async (verdict) => {
        if (verdict.kind === "add") {
          await repo.create(
            seedEntry({
              object_id: addedId,
              content: "Alice lives in Berlin.",
              canonical_entities: ["alice", "berlin"]
            })
          );
        }
        return {};
      }
    );

    expect(decision.kind).toBe("add");
    const row = (await repo.findByIds("workspace-1", [addedId]))[0]!;
    expect(row.canonical_entities).toEqual(["alice", "berlin"]);
  });

  it("does not rewrite a survivor when an LLM UPDATE has no rewrite authorization", async () => {
    const repo = await createReconciliationMemoryRepo();
    const seeded = seedEntry({
      content: "The user works at a firm in Berlin.",
      canonical_entities: ["old-entity"]
    });
    await repo.create(seeded);
    const original = (await repo.findByIds("workspace-1", [seeded.object_id]))[0]!;

    const { deps } = wireRepoDeps(repo, [seeded], { thresholds: { similarityFloor: 0.2 } });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: seeded.object_id,
      reason: "refines the fact"
    }));
    const service = new ReconciliationService(deps);

    const decision = await service.runWithDecision(
      {
        ...baseInput,
        incomingContent: "The user works at a company in Berlin and likes spicy food.",
        incomingDomainTags: ["residence"],
        incomingProjectionFields: { canonical_entities: ["alice", "berlin"] }
      },
      applyUpdateVerdict
    );

    expect(decision.kind).toBe("add");
    const row = (await repo.findByIds("workspace-1", [seeded.object_id]))[0]!;
    expect(row.content).toBe(original.content);
    expect(row.updated_at).toBe(original.updated_at);
    expect(row.canonical_entities).toEqual(["old-entity"]);
  });

  it("refreshes a UPDATE survivor's canonical_entities from the incoming signal", async () => {
    const repo = await createReconciliationMemoryRepo();
    const seeded = seedEntry({ canonical_entities: ["old-entity"] });
    await repo.create(seeded);

    const { deps } = wireRepoDeps(repo, [seeded], {
      thresholds: { similarityFloor: 0.2 },
      rewriteAuthorization: authorizedDurableRewrite
    });
    deps.llmDecision.decide = vi.fn<DecideFn>(async () => ({
      kind: "update",
      targetObjectId: seeded.object_id,
      reason: "refines the fact"
    }));
    const service = new ReconciliationService(deps);

    const newContent = "The user works at a company in Berlin and likes spicy food.";
    const decision = await service.runWithDecision(
      {
        ...baseInput,
        incomingContent: newContent,
        incomingDomainTags: ["residence"],
        incomingProjectionFields: { canonical_entities: ["alice", "berlin"] }
      },
      applyUpdateVerdict
    );

    expect(decision.kind).toBe("update");
    const row = (await repo.findByIds("workspace-1", [seeded.object_id]))[0]!;
    expect(row.content).toBe(newContent);
    expect(row.canonical_entities).toEqual(["alice", "berlin"]);
  });

  it("audits an LLM NOOP and preserves every field of the surviving memory", async () => {
    const { database, memoryRepo: repo } = await createReconciliationSqliteHarness();
    const seeded = seedEntry({ content: "The user lives in Berlin.", canonical_entities: null });
    await repo.create(seeded);
    const original = await repo.findById(seeded.object_id);

    const eventLog = new SqliteEventLogRepo(database);
    const { deps, decide } = wireRepoDeps(repo, [seeded], {
      eventLog,
      thresholds: { similarityFloor: 0.2 }
    });
    decide.mockResolvedValue({ kind: "noop", targetObjectId: seeded.object_id, reason: "duplicate fact" });
    const service = new ReconciliationService(deps);

    const decision = await service.runWithDecision(
      {
        ...baseInput,
        incomingContent: "The user still lives in Berlin today.",
        incomingDomainTags: ["residence"],
        incomingProjectionFields: { canonical_entities: ["alice", "berlin"], time_precision: "day" }
      },
      applyUpdateVerdict
    );

    expect(decision.kind).toBe("noop");
    expect(decide).toHaveBeenCalledOnce();
    await expect(repo.findById(seeded.object_id)).resolves.toEqual(original);
    await expect(eventLog.queryByWorkspace("workspace-1")).resolves.toEqual([
      expect.objectContaining({ caused_by: "reconciliation_noop",
        payload_json: expect.objectContaining({ triage_result: "dropped", surviving_object_id: seeded.object_id }) })
    ]);
  });

  it("preserves a NOOP survivor's existing canonical_entities", async () => {
    const repo = await createReconciliationMemoryRepo();
    const seeded = seedEntry({
      content: "The user lives in Berlin.",
      canonical_entities: ["existing-entity"]
    });
    await repo.create(seeded);

    const { deps } = wireRepoDeps(repo, [seeded]);
    const service = new ReconciliationService(deps);

    const decision = await service.runWithDecision(
      {
        ...baseInput,
        incomingContent: "The user lives in Berlin.",
        incomingDomainTags: ["residence"],
        incomingProjectionFields: { canonical_entities: ["other-entity"] }
      },
      applyUpdateVerdict
    );

    expect(decision.kind).toBe("noop");
    const row = (await repo.findByIds("workspace-1", [seeded.object_id]))[0]!;
    expect(row.canonical_entities).toEqual(["existing-entity"]);
  });
});
