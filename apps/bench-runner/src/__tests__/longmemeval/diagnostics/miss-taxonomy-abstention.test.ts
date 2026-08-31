import { describe, expect, it } from "vitest";
import { readQuestionMissTaxonomy } from
  "../../../diagnostics/miss/diagnostics-miss-taxonomy.js";
import {
  assembledQuestion,
  cohortOnlyQuestion,
  flagOnlyQuestion
} from "./abstention-diagnostic-fixture.js";

describe("miss taxonomy three-way abstention exclusion", () => {
  it("returns null for flag-only and cohort-only rows without an _abs suffix", () => {
    const flagOnly = flagOnlyQuestion("58bf7951");
    const cohortOnly = cohortOnlyQuestion("7c1d9e20");
    expect(flagOnly.question_id.endsWith("_abs")).toBe(false);
    expect(flagOnly.is_abstention).toBe(true);
    expect(cohortOnly.question_id.endsWith("_abs")).toBe(false);
    expect(cohortOnly.is_abstention).toBe(false);
    expect(cohortOnly.cohort_ledger?.dataset_cohort).toBe("abstention");
    expect(readQuestionMissTaxonomy(flagOnly)).toBeNull();
    expect(readQuestionMissTaxonomy(cohortOnly)).toBeNull();
  });

  it("keeps ordinary empty-gold without an abstention mark as evaluation_or_gold_issue", () => {
    const ordinary = assembledQuestion({ questionId: "58bf7951" });
    expect(ordinary.is_abstention).toBe(false);
    expect(ordinary.question_id.endsWith("_abs")).toBe(false);
    expect(ordinary.cohort_ledger?.dataset_cohort).not.toBe("abstention");
    expect(readQuestionMissTaxonomy(ordinary)).toBe("evaluation_or_gold_issue");
  });
});
