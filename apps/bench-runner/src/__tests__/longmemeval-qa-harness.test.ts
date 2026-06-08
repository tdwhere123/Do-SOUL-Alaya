import { describe, expect, it } from "vitest";
import {
  aggregateQaVerdicts,
  answerAbstains,
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

describe("qa-harness judge + abstention predicates", () => {
  it("treats CORRECT-only verdict as correct, CORRECT+WRONG as wrong", () => {
    expect(judgeIsCorrect("CORRECT")).toBe(true);
    expect(judgeIsCorrect("correct.")).toBe(true);
    expect(judgeIsCorrect("WRONG")).toBe(false);
    // probe parity: any WRONG token disqualifies even if CORRECT also appears.
    expect(judgeIsCorrect("CORRECT but actually WRONG")).toBe(false);
  });

  it("detects abstention phrasings", () => {
    expect(answerAbstains("I don't know")).toBe(true);
    expect(answerAbstains("That is not mentioned in the context.")).toBe(true);
    expect(answerAbstains("The user lives in Berlin.")).toBe(false);
  });
});

describe("scoreQaQuestion (answerable)", () => {
  it("answers over stitched context then judges against gold", async () => {
    const { chat, calls } = fakeChat(["Berlin", "CORRECT"]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "q1",
        question: "Where does the user live?",
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
    expect(verdict.modelAnswer).toBe("Berlin");
    expect(verdict.judgeVerdict).toBe("CORRECT");
    // 2 calls: answer then judge.
    expect(calls).toHaveLength(2);
    // answer prompt carries the stitched delivered content + the question.
    expect(calls[0]?.user).toContain("user: I live in Berlin.");
    expect(calls[0]?.user).toContain("Where does the user live?");
    // judge prompt carries gold + model answer.
    expect(calls[1]?.user).toContain("Gold answer: Berlin");
    expect(calls[1]?.user).toContain("Model answer: Berlin");
  });

  it("scores WRONG when the judge disagrees", async () => {
    const { chat } = fakeChat(["Paris", "WRONG"]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "q2",
        question: "Where does the user live?",
        goldAnswer: "Berlin",
        delivered: [{ objectId: "m1", content: "user: I live in Berlin." }]
      },
      chat
    );
    expect(verdict.correct).toBe(false);
    expect(verdict.judgeVerdict).toBe("WRONG");
  });
});

describe("scoreQaQuestion (abstention _abs)", () => {
  it("is correct when the model abstains, with NO judge call", async () => {
    const { chat, calls } = fakeChat(["I don't know."]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "topic_abs",
        question: "What is the user's PIN?",
        goldAnswer: "",
        delivered: [{ objectId: "m1", content: "unrelated fact" }]
      },
      chat
    );
    expect(verdict.isAbstention).toBe(true);
    expect(verdict.correct).toBe(true);
    expect(verdict.judgeVerdict).toBeNull();
    // only the answer call — abstention never spends a judge call.
    expect(calls).toHaveLength(1);
  });

  it("is wrong when the model confidently fabricates on an _abs question", async () => {
    const { chat, calls } = fakeChat(["Your PIN is 1234."]);
    const verdict = await scoreQaQuestion(
      {
        questionId: "topic_abs",
        question: "What is the user's PIN?",
        goldAnswer: "",
        delivered: []
      },
      chat
    );
    expect(verdict.correct).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("aggregateQaVerdicts", () => {
  it("aggregates accuracy and the abstention subset", () => {
    const verdicts: QaQuestionVerdict[] = [
      { questionId: "q1", isAbstention: false, correct: true, modelAnswer: "", judgeVerdict: "CORRECT", contextChars: 0 },
      { questionId: "q2", isAbstention: false, correct: false, modelAnswer: "", judgeVerdict: "WRONG", contextChars: 0 },
      { questionId: "a_abs", isAbstention: true, correct: true, modelAnswer: "", judgeVerdict: null, contextChars: 0 },
      { questionId: "b_abs", isAbstention: true, correct: false, modelAnswer: "", judgeVerdict: null, contextChars: 0 }
    ];
    const agg = aggregateQaVerdicts(verdicts);
    expect(agg.qa_total).toBe(4);
    expect(agg.qa_correct).toBe(2);
    expect(agg.qa_accuracy).toBe(0.5);
    expect(agg.qa_abstention_total).toBe(2);
    expect(agg.qa_abstention_correct).toBe(1);
  });

  it("reports zero accuracy for an empty run without dividing by zero", () => {
    const agg = aggregateQaVerdicts([]);
    expect(agg.qa_total).toBe(0);
    expect(agg.qa_accuracy).toBe(0);
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
