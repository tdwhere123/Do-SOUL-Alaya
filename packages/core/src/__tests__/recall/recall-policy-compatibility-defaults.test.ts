import { describe, expect, it } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("recall policy compatibility defaults", () => {
  it("preserves the historical semantic supplement defaults for policy compatibility", () => {
    const service = new RecallService(createDependencies().dependencies);
    const expected = {
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    };

    expect(
      service.buildDefaultPolicy("chat", createTaskSurface().runtime_id)
        .coarse_filter.semantic_supplement
    ).toEqual(expected);
    expect(
      service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id)
        .coarse_filter.semantic_supplement
    ).toEqual(expected);
  });
});
