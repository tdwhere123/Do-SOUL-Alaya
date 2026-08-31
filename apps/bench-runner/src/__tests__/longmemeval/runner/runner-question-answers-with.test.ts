import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchEdgeFormationMember } from "../../../harness/daemon.js";
import { runAnswersWithEdges } from
  "../../../datasets/longmemeval/runner/question/runner-question.js";

afterEach(() => vi.unstubAllEnvs());

describe("answers-with edges", () => {
  it("accrues answers_with without requiring benchmark embeddings", async () => {
    vi.stubEnv("ALAYA_EXP_ANSWERS_WITH_BAR", "4");
    vi.stubEnv("ALAYA_EXP_ANSWERS_WITH_CAP", "2");
    vi.stubEnv("ALAYA_EXP_ANSWERS_WITH_XSESSION", "0");
    const accrueAnswersWithCoRelevance = vi.fn(async () => ({
      coRelevantPairs: 1,
      keptPairs: 1,
      admitted: 1
    }));
    const members = [
      { memoryId: "memory-a", sessionId: "session-a", formationKey: "formation-a" },
      { memoryId: "memory-b", sessionId: "session-b", formationKey: "formation-b" }
    ] satisfies readonly BenchEdgeFormationMember[];

    const result = await runAnswersWithEdges("q-embedding-disabled", {
      accrueAnswersWithCoRelevance
    }, members);

    expect(result).toEqual({ coRelevantPairs: 1, keptPairs: 1, admitted: 1 });
    expect(accrueAnswersWithCoRelevance).toHaveBeenCalledOnce();
    expect(accrueAnswersWithCoRelevance).toHaveBeenCalledWith(members, {
      bar: 4,
      capPerNode: 2,
      crossSessionOnly: false
    });
  });
});
