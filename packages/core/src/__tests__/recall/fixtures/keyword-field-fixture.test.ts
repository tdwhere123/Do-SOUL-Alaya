import { describe, expect, it, vi } from "vitest";
import {
  keywordSearchMethods,
  withKeywordFieldFixturePorts
} from "./keyword-field-fixture.js";
import { createDependencies } from "../recall-service-test-fixtures.js";

describe("keyword field fixture session pin", () => {
  it("refuses to guess workspace-1 when the caller omits a session", () => {
    const { fieldQuerySession: _session, ...unseeded } = createDependencies([]).dependencies;
    expect(() => withKeywordFieldFixturePorts(unseeded))
      .toThrow(/fieldQuerySession or pinWorkspaceId/u);
  });

  it("seeds the named workspace instead of workspace-1", () => {
    const { fieldQuerySession: _session, ...unseeded } = createDependencies([]).dependencies;
    const wrapped = withKeywordFieldFixturePorts(unseeded, "workspace-other");
    const session = wrapped.fieldQuerySession!;
    expect(session.pinActiveGeneration("workspace-other", "2026-09-06T12:00:00.000Z").workspace_id)
      .toBe("workspace-other");
    expect(() => session.pinActiveGeneration("workspace-1", "2026-09-06T12:00:00.000Z"))
      .toThrow(/active projection generation is missing/u);
  });

  it("rebuilds keyword field search from the live scalar after an override", async () => {
    const planted = vi.fn(async () => [{ object_id: "memory-2", normalized_rank: 1 }]);
    const { fieldQuerySession: _session, ...unseeded } = createDependencies([]).dependencies;
    const wrapped = withKeywordFieldFixturePorts({
      ...unseeded,
      memoryRepo: {
        ...unseeded.memoryRepo,
        ...keywordSearchMethods(planted),
        searchByKeyword: vi.fn(async () => [])
      }
    }, "workspace-1");
    const field = await wrapped.memoryRepo.searchByKeywordField?.(
      "workspace-1",
      "q",
      8
    );
    expect(field?.matches).toEqual([]);
  });
});
