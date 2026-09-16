import { afterEach, describe, expect, it } from "vitest";
import { PreWriteRecallService } from "../../governance/reconciliation/pre-write-recall-service.js";
import { ReconciliationService } from "../../governance/reconciliation/reconciliation-service.js";
import { baseInput, createDeps } from "./reconciliation-service.test-support.js";
import {
  closeReconciliationTestDatabases,
  createReconciliationSqliteHarness,
  seedReconciliationEntry
} from "./reconciliation-real-sqlite.test-support.js";
import type { SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import type { ReconciliationInput } from "../../governance/reconciliation/reconciliation-service.js";

afterEach(closeReconciliationTestDatabases);

const incoming: ReconciliationInput = {
  ...baseInput,
  incomingContent: "The user lives in Berlin.",
  incomingDomainTags: ["residence"]
};

function wirePreWriteRecall(memoryRepo: SqliteMemoryEntryRepo): PreWriteRecallService {
  return new PreWriteRecallService({
    lexicalSearch: {
      searchByKeyword: async (workspaceId, queryText, limit) =>
        await memoryRepo.searchByKeyword(workspaceId, queryText, limit)
    },
    memoryRepo: {
      findByIds: async (workspaceId, objectIds) => await memoryRepo.findByIds(workspaceId, objectIds),
      findByWorkspaceId: async (workspaceId, tier, page) =>
        await memoryRepo.findByWorkspaceId(workspaceId, tier, page)
    },
    limit: 8
  });
}

describe("reconciliation write-path availability with real sqlite", () => {
  it("treats a closed-connection repo throw as unavailable, not an empty neighbor set", async () => {
    const harness = await createReconciliationSqliteHarness();
    await harness.memoryRepo.create(
      seedReconciliationEntry({ content: "The user lives in Berlin." })
    );
    expect(await harness.memoryRepo.countByWorkspaceId("workspace-1")).toBe(1);
    harness.database.close();

    const recall = await wirePreWriteRecall(harness.memoryRepo).recall(incoming);
    expect(recall.availability).toBe("unavailable");
    expect(recall.candidates).toEqual([]);
  });

  it("does not apply ADD when a real memory-repo read throws", async () => {
    const harness = await createReconciliationSqliteHarness();
    await harness.memoryRepo.create(
      seedReconciliationEntry({ content: "The user lives in Berlin." })
    );
    harness.database.close();

    const { deps } = createDeps([], {
      preWriteRecall: wirePreWriteRecall(harness.memoryRepo)
    });
    const service = new ReconciliationService(deps);
    const applied: string[] = [];

    const decision = await service.runWithDecision(incoming, async (verdict) => {
      applied.push(verdict.kind);
      return {};
    });

    expect(decision.kind).toBe("deferred");
    expect(decision.deferral).toBe("prewrite_unavailable");
    expect(decision.retryable).toBe(true);
    expect(applied).toEqual([]);
  });

  it("does not apply ADD when a live reconciliation lease is held", async () => {
    const harness = await createReconciliationSqliteHarness();
    await harness.memoryRepo.create(
      seedReconciliationEntry({ content: "The user lives in Berlin." })
    );
    expect(
      harness.leaseRepo.tryAcquire(
        "workspace-1",
        "other-process",
        "2026-06-01T00:00:00.000Z",
        "2026-06-01T00:05:00.000Z"
      )
    ).not.toBeNull();

    const { deps } = createDeps([], {
      preWriteRecall: wirePreWriteRecall(harness.memoryRepo),
      lease: harness.leaseRepo,
      now: () => new Date("2026-06-01T00:01:00.000Z")
    });
    const service = new ReconciliationService(deps);
    const applied: string[] = [];

    const decision = await service.runWithDecision(incoming, async (verdict) => {
      applied.push(verdict.kind);
      if (verdict.kind === "add") {
        await harness.memoryRepo.create(
          seedReconciliationEntry({
            object_id: "33333333-3333-4333-8333-333333333333",
            content: "The user lives in Berlin."
          })
        );
      }
      return {};
    });

    expect(decision.kind).toBe("deferred");
    expect(decision.deferral).toBe("lease_busy");
    expect(applied).toEqual([]);
    expect(await harness.memoryRepo.countByWorkspaceId("workspace-1")).toBe(1);
    expect(harness.leaseRepo.findByKey("workspace-1")?.owner_token).toBe("other-process");
  });

  it("still ADDs when a successful scan finds no neighbors", async () => {
    const harness = await createReconciliationSqliteHarness();
    const { deps } = createDeps([], {
      preWriteRecall: wirePreWriteRecall(harness.memoryRepo)
    });
    const service = new ReconciliationService(deps);
    const applied: string[] = [];

    const decision = await service.runWithDecision(incoming, async (verdict) => {
      applied.push(verdict.kind);
      return {};
    });

    expect(decision.kind).toBe("add");
    expect(applied).toEqual(["add"]);
  });
});
