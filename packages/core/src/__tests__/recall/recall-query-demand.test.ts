import { describe, expect, it } from "vitest";
import { compileRecallQueryDemand } from
  "../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";

describe("compileRecallQueryDemand", () => {
  it("represents an Assistant recommendation without routing the query", () => {
    const demand = compile("Can you remind me which back-end languages you recommended I learn?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("answer_slot", "choice", "core"),
      atom("source_role", "assistant", "core"),
      atom("relation", "recommended", "supporting"),
      atom("target", "back-end", "supporting"),
      atom("target", "languages", "supporting")
    ]));
  });

  it("keeps colloquial time and the requested fact as independent demands", () => {
    const demand = compile("What did my friend tell me a couple of days ago?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("answer_slot", "fact", "core"),
      atom("temporal", "a couple of days ago", "core"),
      atom("relation", "tell", "supporting"),
      atom("target", "friend", "supporting")
    ]));
    expect(demand.atoms).not.toContainEqual(atom("source_role", "user", "core"));
  });

  it("represents sequence and bounded time without a query-type branch", () => {
    const demand = compile("In what order did I visit cities in the past three months?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("answer_slot", "fact", "core"),
      atom("ordering", "sequence", "core"),
      atom("temporal", "past three months", "core"),
      atom("source_role", "user", "core"),
      atom("relation", "visit", "supporting"),
      atom("target", "cities", "supporting")
    ]));
  });

  it("distinguishes aggregate answer slots from their target", () => {
    const demand = compile("How much total did I spend on train tickets?");

    expect(demand.atoms).toEqual(expect.arrayContaining([
      atom("answer_slot", "amount", "core"),
      atom("source_role", "user", "core"),
      atom("relation", "spend", "supporting"),
      atom("target", "train", "supporting"),
      atom("target", "tickets", "supporting")
    ]));
  });

  it("deduplicates atoms and freezes the resulting state", () => {
    const demand = compile("Which option did you recommend and recommend again?");

    expect(demand.atoms.filter((item) => item.id === "relation:recommend")).toHaveLength(1);
    expect(Object.isFrozen(demand)).toBe(true);
    expect(Object.isFrozen(demand.atoms)).toBe(true);
  });
});

function compile(query: string) {
  return compileRecallQueryDemand(compileRecallQueryProbes(query));
}

function atom(
  kind: "answer_slot" | "source_role" | "ordering" | "temporal" | "target" | "relation",
  value: string,
  priority: "core" | "supporting"
) {
  return { id: `${kind}:${value}`, kind, value, priority };
}
