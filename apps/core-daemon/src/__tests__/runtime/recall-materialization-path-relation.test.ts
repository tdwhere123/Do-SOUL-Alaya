import { describe, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  SqliteCoUsageCounterRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteProposalRepo,
  SqliteRelationAssertionRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import { createRuntimeNotifier } from "../../runtime/runtime-notifier.js";
import { createPathRelationRuntime } from "../../runtime/recall-materialization-path-relation.js";

describe("Garden temporal relation runtime", () => {
  it.each([
    ["fresh default", undefined],
    ["selected temporal projection", true]
  ] as const)("exposes only temporal assertion admission for %s", async (_mode, temporalProjectionSelected) => {
    const database = initDatabase({ filename: ":memory:" });
    let pathRelationEvictionTimer: NodeJS.Timeout | null = null;
    try {
      const eventLogRepo = new SqliteEventLogRepo(database);
      const runtimeNotifier = createRuntimeNotifier();
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier
      });
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const warn = vi.fn();
      const runtime = createPathRelationRuntime({
        coUsageCounterRepo: new SqliteCoUsageCounterRepo(database),
        eventLogRepo,
        eventPublisher,
        memoryEntryRepo: new SqliteMemoryEntryRepo(database),
        pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined },
        pathRelationRepo,
        proposalRepo: new SqliteProposalRepo(database),
        relationAssertionRepo: new SqliteRelationAssertionRepo(database),
        runtimeNotifier,
        ...(temporalProjectionSelected === undefined ? {} : { temporalProjectionSelected }),
        warn
      });
      pathRelationEvictionTimer = runtime.pathRelationEvictionTimer;

      expect(runtime.temporalRelationAssertionPort.admit).toEqual(expect.any(Function));
      expect(runtime).not.toHaveProperty("pathCandidatePort");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (pathRelationEvictionTimer !== null) clearInterval(pathRelationEvictionTimer);
      database.close();
    }
  });
});
