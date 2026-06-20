import { describe, expect, it } from "./locomo-runner.test-support.js";
import { resolveLocomoQaQuestionType } from "../../locomo/runner.js";

describe("resolveLocomoQaQuestionType", () => {
  it("maps category 4 to locomo-open-domain and others to their typed prompts", () => {
    const qa = (category: number) =>
      ({ question: "q", answer: "a", evidence: [], category }) as Parameters<
        typeof resolveLocomoQaQuestionType
      >[0];
    expect(resolveLocomoQaQuestionType(qa(4))).toBe("locomo-open-domain");
    expect(resolveLocomoQaQuestionType(qa(2))).toBe("temporal-reasoning");
    expect(resolveLocomoQaQuestionType(qa(3))).toBe("locomo-aggregation");
    expect(resolveLocomoQaQuestionType(qa(1))).toBe("locomo-factual");
  });
});
