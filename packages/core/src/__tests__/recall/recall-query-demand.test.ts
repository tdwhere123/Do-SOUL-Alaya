import { describe, expect, it } from "vitest";
import { compileRecallQueryDemand } from
  "../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";

describe("compileRecallQueryDemand", () => {
  it("keeps open-vocabulary query terms without assigning semantic roles", () => {
    const demand = compile("Can you remind me which back-end languages you recommended I learn?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("lexical_term", "back-end", "supporting"),
      atom("lexical_term", "languages", "supporting"),
      atom("lexical_term", "recommended", "supporting")
    ]));
    expect(demand.atoms.some(({ id }) => id.startsWith("source_role:"))).toBe(false);
  });

  it("does not turn prospective wording into a ranking branch", () => {
    const demand = compile("Can you recommend a language for my next project?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("lexical_term", "recommend", "supporting"),
      atom("lexical_term", "language", "supporting"),
      atom("lexical_term", "project", "supporting")
    ]));
    expect(demand.atoms.some(({ id }) => id.startsWith("source_role:"))).toBe(false);
  });

  it("keeps colloquial time and the requested fact as independent demands", () => {
    const demand = compile("What did my friend tell me a couple of days ago?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("temporal", "a couple of days ago", "core"),
      atom("lexical_term", "tell", "supporting"),
      atom("lexical_term", "friend", "supporting")
    ]));
  });

  it("represents sequence and bounded time without a query-type branch", () => {
    const demand = compile("In what order did I visit cities in the past three months?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("ordering", "sequence", "core"),
      atom("temporal", "past three months", "core"),
      atom("lexical_term", "visit", "supporting"),
      atom("lexical_term", "cities", "supporting")
    ]));
  });

  it("distinguishes aggregate answer slots from their target", () => {
    const demand = compile("How much total did I spend on train tickets?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("lexical_term", "spend", "supporting"),
      atom("lexical_term", "train", "supporting"),
      atom("lexical_term", "tickets", "supporting")
    ]));
  });

  it("retains content-bearing terms for field-conditioned weighting", () => {
    const demand = compile(
      "I was looking back at our previous chat and wanted to confirm, " +
      "how many times did the Chiefs play the Jaguars at Arrowhead Stadium?"
    );

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("lexical_term", "back", "supporting"),
      atom("lexical_term", "confirm", "supporting"),
      atom("lexical_term", "play", "supporting"),
      atom("lexical_term", "chiefs", "supporting"),
      atom("lexical_term", "jaguars", "supporting"),
      atom("lexical_term", "arrowhead", "supporting"),
      atom("lexical_term", "stadium", "supporting")
    ]));
    expect(demand.atoms).not.toContainEqual(
      atom("lexical_term", "how", "supporting")
    );
  });

  it("leaves phrase value to the field objective instead of a word list", () => {
    const demand = compile(
      "I've been thinking about making a cocktail, but I'm not sure which one to choose."
    );

    expect(demand.atoms).toContainEqual(
      atom("lexical_term", "cocktail", "supporting")
    );
  });

  it("deduplicates atoms and freezes the resulting state", () => {
    const demand = compile("Which option did you recommend and recommend again?");

    expect(demand.atoms.filter((item) =>
      item.id === "lexical_term:recommend")).toHaveLength(1);
    expect(Object.isFrozen(demand)).toBe(true);
    expect(Object.isFrozen(demand.atoms)).toBe(true);
  });
});

function compile(query: string) {
  return compileRecallQueryDemand(compileRecallQueryProbes(query));
}

function atom(
  kind: "ordering" | "temporal" | "lexical_term" | "phrase",
  value: string,
  priority: "core" | "supporting"
) {
  return { id: `${kind}:${value}`, kind, value, priority };
}
