import { afterEach, describe, expect, it, vi } from "vitest";
import { isAnswersWithEdgesEnabled } from "../../longmemeval/runner-question.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("answers-with gate alias", () => {
  it("stays disabled when neither gate is set", () => {
    expect(isAnswersWithEdgesEnabled()).toBe(false);
  });

  it("uses canonical ALAYA_RECALL_ANSWERS_WITH=1 to enable", () => {
    vi.stubEnv("ALAYA_RECALL_ANSWERS_WITH", "1");
    expect(isAnswersWithEdgesEnabled()).toBe(true);
  });

  it("falls back to legacy ALAYA_EXP_ANSWERS_WITH=1", () => {
    vi.stubEnv("ALAYA_EXP_ANSWERS_WITH", "1");
    expect(isAnswersWithEdgesEnabled()).toBe(true);
  });
});
