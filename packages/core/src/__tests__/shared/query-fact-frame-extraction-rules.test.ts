import { describe, expect, it } from "vitest";
import { groundAssociativeFactFrame, type AssociativeFactFrame } from
  "@do-soul/alaya-protocol";
import { projectFactFrameSemanticFactors } from
  "../../recall/field/fact-frame-semantic-factors.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../recall/field/query-facility-demand.js";
import { RuleBasedQueryFactFrameExtractor } from
  "../../shared/query-fact-frame-extraction-rules.js";

const extractor = new RuleBasedQueryFactFrameExtractor();

function expectSourceExactFrame(
  query: string,
  frame: Readonly<AssociativeFactFrame> | undefined
): void {
  expect(frame).toBeDefined();
  expect(groundAssociativeFactFrame(frame, query)).toEqual(frame);
  const roles = new Set(frame!.slots.map((slot) => slot.role));
  expect(roles.has("subject")).toBe(true);
  expect(roles.has("relation")).toBe(true);
  expect(roles.has("value")).toBe(true);
}

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

  it("keeps a name-of possessive noun phrase as the of-complement subject", async () => {
    const query = "What is the name of my cat?";
    const [frame] = await extractor.extract(query);
    expectSourceExactFrame(query, frame);
    expect(frame?.slots).toEqual([
      { role: "value", text: "What" },
      { role: "relation", text: "name" },
      { role: "subject", text: "my cat" }
    ]);
  });

  it("keeps name-of relative material as source-exact relation and qualifier slots", async () => {
    const query = "What is the name of the playlist I created on Spotify?";
    const [frame] = await extractor.extract(query);
    expectSourceExactFrame(query, frame);
    expect(frame?.slots).toEqual([
      { role: "value", text: "What" },
      { role: "relation", text: "name" },
      { role: "subject", text: "the playlist" },
      { role: "relation", text: "created" },
      { role: "qualifier", text: "Spotify" }
    ]);
  });

  it("extracts an unmarked who-subject gift question without fabricating text", async () => {
    const query = "Who gave me a new stand mixer as a birthday gift?";
    const [frame] = await extractor.extract(query);
    expectSourceExactFrame(query, frame);
    expect(frame?.slots).toEqual([
      { role: "value", text: "Who" },
      { role: "relation", text: "gave" },
      { role: "subject", text: "a new stand mixer" },
      { role: "qualifier", text: "a birthday gift" }
    ]);
  });

  it("extracts a how-many relative without putting the measure filler in a slot", async () => {
    const query = "How many movie festivals that I attended?";
    const [frame] = await extractor.extract(query);
    expectSourceExactFrame(query, frame);
    expect(frame?.slots).toEqual([
      { role: "value", text: "movie festivals" },
      { role: "subject", text: "I" },
      { role: "relation", text: "attended" }
    ]);
    expect(frame?.slots.some((slot) => /\bmany\b/iu.test(slot.text))).toBe(false);
  });

  it("extracts a how-long locative copular question from the measure layout", async () => {
    const query = "How long was I in Japan for?";
    const [frame] = await extractor.extract(query);
    expectSourceExactFrame(query, frame);
    expect(frame?.slots).toEqual([
      { role: "value", text: "How long" },
      { role: "relation", text: "was" },
      { role: "subject", text: "I" },
      { role: "qualifier", text: "Japan" }
    ]);
    expect(frame?.slots.some((slot) => slot.text === "I in Japan for")).toBe(false);
    expect(frame?.slots.some((slot) => slot.text === "Japan")).toBe(true);

    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: { schema_version: 1, atoms: [] },
      weights: {
        entity: 1,
        relation: 1,
        time: 1,
        logical_object: 1,
        independent_evidence: 1
      },
      semantic_factors: projectFactFrameSemanticFactors(frame!.slots, 0)
    });
    const entityValues = receipt.demand_atoms
      .filter((atom) => atom.kind === "entity")
      .map((atom) => atom.value);
    expect(entityValues).toContain("japan");
    expect(entityValues).not.toContain("in japan for");
  });

  it("keeps an ordinary copular measure question on the content-relation path", async () => {
    const query = "How long is my daily commute to work?";
    const [frame] = await extractor.extract(query);
    expectSourceExactFrame(query, frame);
    expect(frame?.slots).toEqual([
      { role: "value", text: "How long" },
      { role: "subject", text: "my" },
      { role: "relation", text: "daily" },
      { role: "relation", text: "commute" }
    ]);
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
