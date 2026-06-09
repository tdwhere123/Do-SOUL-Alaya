import { describe, expect, it } from "vitest";
import {
  aggregateQaVerdicts,
  buildQaAnswerContext,
  judgeIsCorrect,
  scoreQaQuestion,
  type QaQuestionVerdict
} from "../longmemeval/qa-harness.js";
import type { QaChatFn } from "../longmemeval/qa-chat.js";
import {
  QA_ENV_API_KEY,
  QA_ENV_MODEL,
  QA_ENV_PROVIDER_URL,
  createGardenChatFn,
  resolveQaChatConfig
} from "../longmemeval/qa-chat.js";

// A fake chat fn that records every (system,user) call and replays scripted
// replies. Zero network, zero cost — the whole point of the --qa unit gate.
function fakeChat(replies: readonly string[]): {
  chat: QaChatFn;
  calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  let i = 0;
  const chat: QaChatFn = async (system, user) => {
    calls.push({ system, user });
    return replies[i++] ?? "";
  };
  return { chat, calls };
}

describe("qa-harness context stitching", () => {
  it("joins delivered top-k content in rank order and caps length", () => {
    const ctx = buildQaAnswerContext([
      { objectId: "a", content: "first fact" },
      { objectId: "b", content: "" },
      { objectId: "c", content: "second fact" }
    ]);
    // empty content is dropped; order preserved.
    expect(ctx).toBe("first fact\n\nsecond fact");
  });

  it("caps the stitched context at 20000 chars", () => {
    const long = "x".repeat(30_000);
    const ctx = buildQaAnswerContext([{ objectId: "a", content: long }]);
    expect(ctx.length).toBe(20_000);
  });
});

describe("qa-harness judge verdict (one-word yes/no)", () => {
  it("treats yes-only as correct, no or yes+no as wrong", () => {
    expect(judgeIsCorrect("yes")).toBe(true);
    expect(judgeIsCorrect("Yes.")).toBe(true);
    expect(judgeIsCorrect("no")).toBe(false);
    // any no token disqualifies even if yes also appears.
    expect(judgeIsCorrect("yes but actually no")).toBe(false);
  });
});

describe("scoreQaQuestion (answerable, factual)", () => {
  it("answers over stitched context then judges against gold", async () => {
    const { chat, calls } = fakeChat(["Berlin", "yes"]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "q1",
        questionType: "single-session-user",
        question: "Where does the user live?",
        questionDate: "2023/05/10 (Wed) 09:00",
        goldAnswer: "Berlin",
        delivered: [
          { objectId: "m1", content: "user: I live in Berlin." },
          { objectId: "m2", content: "filler" }
        ]
      },
      chat
    );
    expect(verdict.correct).toBe(true);
    expect(verdict.isAbstention).toBe(false);
    expect(verdict.questionType).toBe("single-session-user");
    expect(verdict.modelAnswer).toBe("Berlin");
    expect(verdict.judgeVerdict).toBe("yes");
    // 2 calls: answer then judge.
    expect(calls).toHaveLength(2);
    // answer prompt carries the current date (now), stitched content + question.
    expect(calls[0]?.user).toContain("Current date: 2023/05/10");
    expect(calls[0]?.user).toContain("user: I live in Berlin.");
    expect(calls[0]?.user).toContain("Where does the user live?");
    // factual judge template carries the correct answer + model response.
    expect(calls[1]?.user).toContain("Correct Answer: Berlin");
    expect(calls[1]?.user).toContain("Model Response: Berlin");
  });

  it("scores wrong when the judge disagrees", async () => {
    const { chat } = fakeChat(["Paris", "no"]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "q2",
        questionType: "multi-session",
        question: "Where does the user live?",
        questionDate: "2023/05/10 (Wed) 09:00",
        goldAnswer: "Berlin",
        delivered: [{ objectId: "m1", content: "user: I live in Berlin." }]
      },
      chat
    );
    expect(verdict.correct).toBe(false);
    expect(verdict.judgeVerdict).toBe("no");
  });
});

describe("scoreQaQuestion (preference uses rubric template)", () => {
  it("picks the preference answer prompt and grades against a rubric", async () => {
    const { chat, calls } = fakeChat(["Try Adobe Premiere Pro tutorials.", "yes"]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "p1",
        questionType: "single-session-preference",
        question: "Recommend some video editing resources.",
        questionDate: "2023/05/10 (Wed) 09:00",
        goldAnswer: "The user would prefer Adobe Premiere Pro resources.",
        delivered: [{ objectId: "m1", content: "user: I edit in Premiere Pro." }]
      },
      chat
    );
    expect(verdict.correct).toBe(true);
    expect(verdict.questionType).toBe("single-session-preference");
    // answer side uses the personalization prompt, not the abstain-friendly one.
    expect(calls[0]?.system).toContain("personalizing");
    // judge side frames gold as a Rubric, not a Correct Answer.
    expect(calls[1]?.user).toContain("Rubric: The user would prefer");
  });
});

describe("scoreQaQuestion (abstention _abs uses the abstention judge)", () => {
  it("is correct when the judge agrees the model abstained", async () => {
    const { chat, calls } = fakeChat(["I don't know.", "yes"]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "topic_abs",
        questionType: "single-session-user",
        question: "What is the user's PIN?",
        questionDate: "2023/05/10 (Wed) 09:00",
        goldAnswer: "The information provided is not enough.",
        delivered: [{ objectId: "m1", content: "unrelated fact" }]
      },
      chat
    );
    expect(verdict.isAbstention).toBe(true);
    expect(verdict.correct).toBe(true);
    expect(verdict.judgeVerdict).toBe("yes");
    // abstention judge template frames gold as an Explanation.
    expect(calls[1]?.user).toContain("Explanation: The information provided");
    expect(calls).toHaveLength(2);
  });

  it("is wrong when the model confidently fabricates on an _abs question", async () => {
    const { chat, calls } = fakeChat(["Your PIN is 1234.", "no"]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "topic_abs",
        questionType: "single-session-user",
        question: "What is the user's PIN?",
        questionDate: "2023/05/10 (Wed) 09:00",
        goldAnswer: "The information provided is not enough.",
        delivered: []
      },
      chat
    );
    expect(verdict.isAbstention).toBe(true);
    expect(verdict.correct).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("aggregateQaVerdicts", () => {
  it("aggregates accuracy, the abstention subset, and per-type tallies", () => {
    const verdicts: QaQuestionVerdict[] = [
      { questionId: "q1", questionType: "multi-session", isAbstention: false, correct: true, modelAnswer: "", judgeVerdict: "yes", contextChars: 0 },
      { questionId: "q2", questionType: "multi-session", isAbstention: false, correct: false, modelAnswer: "", judgeVerdict: "no", contextChars: 0 },
      { questionId: "a_abs", questionType: "single-session-user", isAbstention: true, correct: true, modelAnswer: "", judgeVerdict: "yes", contextChars: 0 },
      { questionId: "b_abs", questionType: "single-session-user", isAbstention: true, correct: false, modelAnswer: "", judgeVerdict: "no", contextChars: 0 }
    ];
    const agg = aggregateQaVerdicts(verdicts);
    expect(agg.qa_total).toBe(4);
    expect(agg.qa_correct).toBe(2);
    expect(agg.qa_accuracy).toBe(0.5);
    expect(agg.qa_abstention_total).toBe(2);
    expect(agg.qa_abstention_correct).toBe(1);
    expect(agg.qa_by_type["multi-session"]).toEqual({ total: 2, correct: 1 });
    expect(agg.qa_by_type["single-session-user"]).toEqual({ total: 2, correct: 1 });
  });

  it("reports zero accuracy for an empty run without dividing by zero", () => {
    const agg = aggregateQaVerdicts([]);
    expect(agg.qa_total).toBe(0);
    expect(agg.qa_accuracy).toBe(0);
    expect(agg.qa_by_type).toEqual({});
  });
});

describe("resolveQaChatConfig (env gating)", () => {
  it("resolves url/key/model from env", () => {
    const config = resolveQaChatConfig({
      [QA_ENV_PROVIDER_URL]: "https://yunwu.ai/v1",
      [QA_ENV_API_KEY]: "sk-test",
      [QA_ENV_MODEL]: "gpt-5.4-nano"
    } as NodeJS.ProcessEnv);
    expect(config.url).toBe("https://yunwu.ai/v1");
    expect(config.apiKey).toBe("sk-test");
    expect(config.model).toBe("gpt-5.4-nano");
  });

  it("defaults the model when unset", () => {
    const config = resolveQaChatConfig({
      [QA_ENV_PROVIDER_URL]: "https://yunwu.ai/v1",
      [QA_ENV_API_KEY]: "sk-test"
    } as NodeJS.ProcessEnv);
    expect(config.model).toBe("gpt-5.4-nano");
  });

  it("throws when url or key is missing (fail-loud, no silent degrade)", () => {
    expect(() =>
      resolveQaChatConfig({ [QA_ENV_API_KEY]: "sk-test" } as NodeJS.ProcessEnv)
    ).toThrow(/PROVIDER_URL/u);
    expect(() =>
      resolveQaChatConfig({
        [QA_ENV_PROVIDER_URL]: "https://yunwu.ai/v1"
      } as NodeJS.ProcessEnv)
    ).toThrow(/API_KEY/u);
  });

  it("builds a real chat fn without firing any network call at construction", () => {
    // constructing the fn must not touch the network; we never invoke it here.
    const fn = createGardenChatFn({
      url: "https://example.invalid/v1",
      apiKey: "sk",
      model: "m"
    });
    expect(typeof fn).toBe("function");
  });
});
