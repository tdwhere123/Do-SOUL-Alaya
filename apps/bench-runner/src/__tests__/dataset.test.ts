import { describe, expect, it } from "vitest";
import { pairSessionIntoRounds } from "../longmemeval/dataset.js";
import type { LongMemEvalTurn } from "../longmemeval/dataset.js";

function turn(
  role: string,
  content: string,
  hasAnswer?: boolean
): LongMemEvalTurn {
  return hasAnswer === undefined
    ? { role, content }
    : { role, content, has_answer: hasAnswer };
}

describe("pairSessionIntoRounds", () => {
  it("pairs a strictly alternating session into user+assistant rounds", () => {
    const rounds = pairSessionIntoRounds([
      turn("user", "hi"),
      turn("assistant", "hello"),
      turn("user", "what is 2+2"),
      turn("assistant", "4")
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.messageIndices).toEqual([0, 1]);
    expect(rounds[0]?.content).toBe("User: hi\nAssistant: hello");
    expect(rounds[1]?.messageIndices).toEqual([2, 3]);
    expect(rounds[1]?.content).toBe("User: what is 2+2\nAssistant: 4");
  });

  it("makes a trailing unpaired user message its own single-message round", () => {
    const rounds = pairSessionIntoRounds([
      turn("user", "hi"),
      turn("assistant", "hello"),
      turn("user", "one more thing")
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[1]?.messageIndices).toEqual([2]);
    expect(rounds[1]?.content).toBe("User: one more thing");
  });

  it("never drops content when roles do not strictly alternate", () => {
    // two user messages in a row, then a leading-assistant case
    const session = [
      turn("user", "first"),
      turn("user", "second"),
      turn("assistant", "reply"),
      turn("assistant", "extra")
    ];
    const rounds = pairSessionIntoRounds(session);
    // first user cannot pair with another user -> its own round;
    // second user pairs with the assistant reply; trailing assistant alone.
    expect(rounds.map((round) => round.messageIndices)).toEqual([
      [0],
      [1, 2],
      [3]
    ]);
    // every source message index is covered exactly once
    const covered = rounds.flatMap((round) => round.messageIndices).sort();
    expect(covered).toEqual([0, 1, 2, 3]);
  });

  it("marks a round answer-bearing if any covered message has has_answer", () => {
    const rounds = pairSessionIntoRounds([
      turn("user", "where do I live"),
      turn("assistant", "you live in Berlin", true)
    ]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.hasAnswer).toBe(true);
  });

  it("marks an odd-message round answer-bearing from its lone message", () => {
    const rounds = pairSessionIntoRounds([
      turn("user", "a context message"),
      turn("assistant", "an answer"),
      turn("user", "the answer-bearing trailing message", true)
    ]);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.hasAnswer).toBe(false);
    expect(rounds[1]?.messageIndices).toEqual([2]);
    expect(rounds[1]?.hasAnswer).toBe(true);
  });

  it("handles an empty session", () => {
    expect(pairSessionIntoRounds([])).toEqual([]);
  });
});
