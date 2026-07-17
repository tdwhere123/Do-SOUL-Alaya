import { describe, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

function temporalMemory(objectId: string, eventDate: string) {
  return createMemoryEntry({
    object_id: objectId,
    dimension: MemoryDimension.FACT,
    content: "The parents attended the neighborhood concert together.",
    event_time_start: `${eventDate}T00:00:00.000Z`,
    event_time_end: `${eventDate}T23:59:59.999Z`
  });
}

describe("RecallService reference time", () => {
  it("uses the explicit reference time to rank the requested relative day", async () => {
    const distractor = temporalMemory("11111111-1111-4111-8111-111111111111", "2026-08-08");
    const requested = temporalMemory("99999999-9999-4999-8999-999999999999", "2026-08-15");
    const { dependencies } = createDependencies([distractor, requested]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert last Saturday?"
      },
      referenceTime: "2026-08-22T08:01:00.000Z"
    });

    expect(result.candidates[0]?.object_id).toBe(requested.object_id);
    const requestedDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === requested.object_id
    );
    expect(requestedDiagnostic?.per_axis_contribution?.temporal).toBe(1);
  });

  it("rejects an invalid explicit reference time", async () => {
    const { dependencies } = createDependencies([]);
    const service = new RecallService(dependencies);
    await expect(service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      referenceTime: "not-a-date"
    })).rejects.toThrow(/reference time/iu);
    await expect(service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      referenceTime: "2026-08-23T00:30:00"
    })).rejects.toThrow(/timezone offset/iu);
  });

  it("uses the explicit fixed offset for relative calendar days", async () => {
    const previous = temporalMemory("11111111-1111-4111-8111-111111111111", "2026-08-15");
    const localPrevious = temporalMemory("99999999-9999-4999-8999-999999999999", "2026-08-22");
    const { dependencies } = createDependencies([previous, localPrevious]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert last Saturday?"
      },
      referenceTime: "2026-08-23T00:30:00+08:00"
    });

    expect(result.candidates[0]?.object_id).toBe(localPrevious.object_id);
  });

  it("threads an explicit reference time to every temporal path-dependent read", async () => {
    const first = temporalMemory("11111111-1111-4111-8111-111111111111", "2026-08-15");
    const second = temporalMemory("99999999-9999-4999-8999-999999999999", "2026-08-16");
    const { dependencies } = createDependencies([first, second]);
    const findByAnchors = vi.fn(async () => []);
    const getStrengthByMemoryId = vi.fn(async () => new Map<string, number>());
    const findActiveConstraints = vi.fn(async () => ({ constraints: [], total_count: 0 }));
    const countInboundEdgesWeighted = vi.fn(async () => 0);
    const countInboundRecalls = vi.fn(async () => 0);
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort: { findByAnchors },
      pathPlasticityPort: { getStrengthByMemoryId },
      activeConstraintsPort: { findActiveConstraints },
      graphSupportPort: {
        countInboundSupports: vi.fn(async () => 0),
        countInboundEdgesWeighted,
        countInboundRecalls
      }
    });
    const referenceTime = "2026-08-23T00:30:00+08:00";

    await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Which concert memory is relevant?"
      },
      referenceTime
    });

    expect(findByAnchors).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(Array),
      { asOf: referenceTime }
    );
    expect(getStrengthByMemoryId).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(Array),
      { asOf: referenceTime }
    );
    expect(findActiveConstraints).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cap: null,
      asOf: referenceTime
    });
    expect(countInboundEdgesWeighted).toHaveBeenCalledWith(
      expect.any(String),
      "workspace-1",
      { asOf: referenceTime }
    );
    expect(countInboundRecalls).toHaveBeenCalledWith(
      expect.any(String),
      "workspace-1",
      { asOf: referenceTime }
    );
  });
});
