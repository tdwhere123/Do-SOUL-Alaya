import { describe, expect, it, vi } from "vitest";
import {
  keywordSearchMethods,
  withKeywordFieldFixturePorts
} from "./keyword-field-fixture.js";
import { createDependencies } from "../recall-service-test-fixtures.js";

describe("keyword field fixture", () => {
  it("rebuilds keyword field search from the live scalar after an override", async () => {
    const planted = vi.fn(async () => [{ object_id: "memory-2", normalized_rank: 1 }]);
    const { dependencies } = createDependencies([]);
    const wrapped = withKeywordFieldFixturePorts({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo!,
        ...keywordSearchMethods(planted),
        searchByKeyword: vi.fn(async () => [])
      }
    });
    const field = await wrapped.memoryRepo!.searchByKeywordField?.(
      "workspace-1",
      "q",
      8
    );
    expect(field?.matches).toEqual([]);
  });
});
