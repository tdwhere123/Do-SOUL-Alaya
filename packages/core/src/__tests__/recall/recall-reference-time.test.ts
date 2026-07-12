import { describe, expect, it } from "vitest";
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
});
