import { describe, expect, it } from "vitest";
import { RuleBasedQueryFactFrameExtractor } from
  "../../shared/query-fact-frame-extraction-rules.js";

const extractor = new RuleBasedQueryFactFrameExtractor();

describe("RuleBasedQueryFactFrameExtractor", () => {
  it("extracts a source-ordered do-support question frame", async () => {
    await expect(extractor.extract("What did Alice buy at the market?")).resolves.toEqual([{
      schema_version: 1,
      slots: [
        { role: "value", text: "What" },
        { role: "subject", text: "Alice" },
        { role: "relation", text: "buy" }
      ]
    }]);
  });

  it("keeps a possessive subject and source-exact copular relation tokens", async () => {
    await expect(extractor.extract("What is Alice's favorite color?")).resolves.toEqual([{
      schema_version: 1,
      slots: [
        { role: "value", text: "What" },
        { role: "subject", text: "Alice's" },
        { role: "relation", text: "favorite" },
        { role: "relation", text: "color" }
      ]
    }]);
  });

  it("supports relation-before-subject copular questions", async () => {
    await expect(extractor.extract("What is the capital of France?")).resolves.toEqual([{
      schema_version: 1,
      slots: [
        { role: "value", text: "What" },
        { role: "relation", text: "capital" },
        { role: "subject", text: "France" }
      ]
    }]);
  });

  it("extracts a passive copular predicate", async () => {
    await expect(extractor.extract("Where was Alice born?")).resolves.toEqual([{
      schema_version: 1,
      slots: [
        { role: "value", text: "Where" },
        { role: "subject", text: "Alice" },
        { role: "relation", text: "born" }
      ]
    }]);
  });

  it("keeps expected-value nouns out of the relation role", async () => {
    await expect(extractor.extract("Which city did Alice visit?")).resolves.toEqual([{
      schema_version: 1,
      slots: [
        { role: "value", text: "Which city" },
        { role: "subject", text: "Alice" },
        { role: "relation", text: "visit" }
      ]
    }]);
  });

  it("uses interrogative grammar rather than a closed relation vocabulary", async () => {
    const [frame] = await extractor.extract("What did Alice frobnicate?");
    expect(frame?.slots).toContainEqual({ role: "relation", text: "frobnicate" });
  });

  it("treats an auxiliary-shaped token as the main predicate after do-support", async () => {
    const [frame] = await extractor.extract("How many playlists do I have on Spotify?");
    expect(frame?.slots).toEqual([
      { role: "value", text: "How many playlists" },
      { role: "subject", text: "I" },
      { role: "relation", text: "have" }
    ]);
  });

  it("uses possessive determiners as source-exact self subjects", async () => {
    const [frame] = await extractor.extract("What was my previous occupation?");
    expect(frame?.slots).toEqual([
      { role: "value", text: "What" },
      { role: "subject", text: "my" },
      { role: "relation", text: "previous" },
      { role: "relation", text: "occupation" }
    ]);
  });

  it("does not leak a subordinate clause into copular relation roles", async () => {
    const [frame] = await extractor.extract("What was my last name before I changed it?");
    expect(frame?.slots).toEqual([
      { role: "value", text: "What" },
      { role: "subject", text: "my" },
      { role: "relation", text: "last" },
      { role: "relation", text: "name" }
    ]);
  });

  it("rejects an of-relation whose subject continues into a relative clause", async () => {
    await expect(extractor.extract(
      "What is the name of the playlist I created on Spotify?"
    )).resolves.toEqual([]);
  });

  it("does not invert an of-complement when the copular predicate continues", async () => {
    await expect(extractor.extract(
      "How much is the painting of a sunset worth in terms of the amount I paid?"
    )).resolves.toEqual([]);
  });

  it("fails closed on an unmarked relative clause after a determiner subject", async () => {
    await expect(extractor.extract(
      "What was the discount I got on my first purchase?"
    )).resolves.toEqual([]);
  });

  it("does not label perfect-progressive been as a relation", async () => {
    await expect(extractor.extract(
      "How long had I been bird watching when I attended the workshop?"
    )).resolves.toEqual([]);
  });

  it("stops copular relation roles at a prepositional boundary", async () => {
    const [frame] = await extractor.extract(
      "What is my current record in the recreational volleyball league?"
    );
    expect(frame?.slots).toEqual([
      { role: "value", text: "What" },
      { role: "subject", text: "my" },
      { role: "relation", text: "current" },
      { role: "relation", text: "record" }
    ]);
  });

  it("does not turn a comparative boundary into a relation", async () => {
    await expect(extractor.extract(
      "How many years older am I than when I graduated from college?"
    )).resolves.toEqual([]);
  });

  it("fails closed when the question does not prove every required role", async () => {
    await expect(extractor.extract("Who visited Paris?")).resolves.toEqual([]);
    await expect(extractor.extract("Did Alice visit Paris?")).resolves.toEqual([]);
    await expect(extractor.extract("Tell me about Alice")).resolves.toEqual([]);
    await expect(extractor.extract("Who is Alice?")).resolves.toEqual([]);
  });

  it("honors a zero frame budget", async () => {
    await expect(extractor.extract("What did Alice buy?", { maxFrames: 0 }))
      .resolves.toEqual([]);
  });

  it("fails closed before exceeding the protocol slot bound", async () => {
    await expect(extractor.extract(
      "What did Alice always also recently usually frobnicate?"
    )).resolves.toEqual([]);
  });

  it("fails closed before emitting an oversized protocol slot", async () => {
    await expect(extractor.extract(
      `What did ${"A".repeat(513)} buy?`
    )).resolves.toEqual([]);
  });

  it("returns deterministic frozen frames", async () => {
    const first = await extractor.extract("What did Alice buy?");
    const second = await extractor.extract("What did Alice buy?");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.slots)).toBe(true);
    expect(Object.isFrozen(first[0]?.slots[0])).toBe(true);
  });
});
