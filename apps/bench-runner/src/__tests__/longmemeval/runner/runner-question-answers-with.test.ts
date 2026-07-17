import { describe, expect, it } from "vitest";
import { isAnswersWithEdgesEnabled } from "../../../longmemeval/runner/question/runner-question.js";

describe("answers-with edges", () => {
  it("is always enabled", () => {
    expect(isAnswersWithEdgesEnabled()).toBe(true);
  });
});
