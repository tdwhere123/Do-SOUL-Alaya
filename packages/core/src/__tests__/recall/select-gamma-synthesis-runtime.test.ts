import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("RecallService Select_Gamma synthesis", () => {
  it("invokes the optional port after selection and exposes its metadata", async () => {
    const memory = createMemoryEntry({ object_id: "selected-memory" });
    const { dependencies } = createDependencies([memory]);
    const synthesize = vi.fn(async () => ({ text: "selected evidence summary" }));
    const service = new RecallService({
      ...dependencies,
      selectGammaSynthesisPort: { synthesize }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      runId: "run-1"
    });

    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "workspace-1",
      run_id: "run-1",
      selected_evidence: result.candidates
    }));
    expect(result.candidates.map(({ object_id }) => object_id)).toEqual([
      "selected-memory"
    ]);
    expect(result.synthesis).toEqual({
      status: "ok",
      text: "selected evidence summary"
    });
  });
});
