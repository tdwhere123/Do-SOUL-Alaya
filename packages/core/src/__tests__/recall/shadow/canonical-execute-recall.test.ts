import { afterEach, describe, expect, it, vi } from "vitest";
import * as fineAssessment from "../../../recall/delivery/fine-assessment.js";
import * as gamma from "../../../recall/delivery/select-gamma/select-gamma.js";
import { RecallService } from "../../../recall/recall-service.js";
import { CANONICAL_CAPTURE_IDENTITY } from "../../../recall/shadow/canonical-delivery.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

describe("omitted delivery_path executeRecall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hits canonical delivery and never prepares the legacy assessment", async () => {
    const prepare = vi.spyOn(fineAssessment, "prepareFineAssessment");
    const assess = vi.spyOn(fineAssessment, "fineAssess");
    const gammaWalk = vi.spyOn(gamma, "selectGammaWalk");
    const diagnosticObserver = vi.fn(() => undefined);
    const memory = createMemoryEntry({
      object_id: "memory-canonical",
      content: "I take yoga classes at Serenity Yoga."
    });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy
    });
    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Where do I take yoga classes?"
      },
      workspaceId: "workspace-1",
      strategy: "analyze",
      diagnosticObserver
    });

    expect(result.delivery_path).toBe("canonical");
    expect(result.ranking_authority).toBe("prefix_sk");
    expect(result.capture_identity).toEqual(CANONICAL_CAPTURE_IDENTITY);
    expect(result.candidates.every((candidate) => candidate.relevance_score === 0)).toBe(true);
    expect(assess).toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(gammaWalk).not.toHaveBeenCalled();
    expect(diagnosticObserver).toHaveBeenCalledOnce();
    expect(diagnosticObserver.mock.calls[0]?.[0].result.ranking_authority)
      .toBe("prefix_sk");
  });

  it("commits an injectable read snapshot before recall side effects", async () => {
    const events: string[] = [];
    const memory = createMemoryEntry({
      object_id: "memory-snapshot",
      content: "I take yoga classes at Serenity Yoga."
    });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy,
      readSnapshot: {
        beginDeferred: () => events.push("begin"),
        commit: () => events.push("commit"),
        rollback: () => events.push("rollback")
      },
      eventLogRepo: {
        ...dependencies.eventLogRepo,
        append: async (...args) => {
          events.push("side-effect");
          return await dependencies.eventLogRepo.append(...args);
        }
      }
    });

    await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(events.indexOf("begin")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("commit")).toBeGreaterThan(events.indexOf("begin"));
    expect(events.indexOf("side-effect")).toBeGreaterThan(events.indexOf("commit"));
    expect(events).not.toContain("rollback");
  });

  it("fails closed duplicate live candidates with one exact diagnostic row", async () => {
    const memory = createMemoryEntry({
      object_id: "memory-duplicate",
      content: "I take yoga classes at Serenity Yoga."
    });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy,
      testOnlyTransformCoarseCandidates: (candidates) =>
        candidates[0] === undefined ? candidates : [candidates[0], candidates[0]]
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      diagnosticCapture: "answer_features"
    });

    expect(result.candidates).toEqual([]);
    expect(result.capture_execution).toEqual({ status: "fail_closed", reason: "invalid_state" });
    expect(result.diagnostics?.candidates).toHaveLength(1);
    expect(result.diagnostics?.capture_receipt?.dispositions).toHaveLength(1);
    expect(result.diagnostics?.candidates[0]?.candidate_key)
      .toBe(result.diagnostics?.capture_receipt?.dispositions[0]?.candidate_key);
  });
});
