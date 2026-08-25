import { afterEach, describe, expect, it, vi } from "vitest";
import * as fineAssessment from "../../../recall/delivery/fine-assessment.js";
import * as gamma from "../../../recall/delivery/select-gamma/select-gamma.js";
import { RecallService } from "../../../recall/recall-service.js";
import { CANONICAL_D0_IDENTITY } from "../../../recall/shadow/canonical-delivery.js";
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
      strategy: "analyze"
    });

    expect(result.delivery_path).toBe("canonical");
    expect(result.ranking_authority).toBe("d0_prefix");
    expect(result.d0_identity).toEqual(CANONICAL_D0_IDENTITY);
    expect(result.candidates.every((candidate) => candidate.relevance_score === 0)).toBe(true);
    expect(assess).toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(gammaWalk).not.toHaveBeenCalled();
  });
});
