import { describe, expect, it } from "vitest";
import {
  createFieldBackedRecallService
} from
  "./fixtures/keyword-field-fixture.js";
import {
  createDependencies,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("retained component contracts", () => {
it("keeps the keyword supplement enabled for chat and analyze", () => {
    const service = createFieldBackedRecallService(createDependencies([]).dependencies);
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
