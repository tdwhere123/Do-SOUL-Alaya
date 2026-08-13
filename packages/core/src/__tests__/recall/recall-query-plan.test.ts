import { describe, expect, it } from "vitest";
import {
  classifyRecallIntent,
  hasTemporalQuerySignal
} from "../../recall/query/recall-query-plan.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";

const intentFor = (query: string) => classifyRecallIntent(compileRecallQueryProbes(query));
const temporalSignalFor = (query: string) =>
  hasTemporalQuerySignal(compileRecallQueryProbes(query));

describe("classifyRecallIntent", () => {
  it("classifies knowledge-update, temporal, list, preference, and single-fact", () => {
    expect(intentFor("what did I originally use, now changed?")).toBe("knowledge_update");
    expect(intentFor("what happened before the move")).toBe("temporal");
    expect(intentFor("which restaurants did we visit")).toBe("list");
    expect(intentFor("do I prefer espresso and cappuccino and latte and mocha")).toBe("preference");
    expect(intentFor("where is the warehouse located")).toBe("single_fact");
  });

  it("does not treat month-name path-source text as temporal intent", () => {
    expect(intentFor("november path source")).toBe("single_fact");
  });

  it("does not treat pure ordinal names as temporal signals", () => {
    expect(intentFor("What is Alice's first name?")).toBe("single_fact");
    expect(temporalSignalFor("What is Alice's first name?")).toBe(false);
    expect(intentFor("What is Alice's last name?")).toBe("single_fact");
    expect(temporalSignalFor("What is Alice's last name?")).toBe(false);
    expect(intentFor("Which last name do I prefer?")).toBe("preference");
    expect(temporalSignalFor("Which last name do I prefer?")).toBe(false);
  });

  it.each([
    "What happened last week?",
    "When did this happen?"
  ])("keeps an explicit temporal question temporal: %s", (query) => {
    expect(intentFor(query)).toBe("temporal");
    expect(temporalSignalFor(query)).toBe(true);
  });

  it("keeps explicit time/date cues in the shared temporal signal", () => {
    expect(temporalSignalFor("What changed on this date?")).toBe(true);
  });

  it("keeps recommend-style queries as single_fact", () => {
    expect(intentFor("recommend a good coffee shop")).toBe("single_fact");
    expect(intentFor("can you suggest a restaurant for tonight")).toBe("single_fact");
    expect(intentFor("would you recommend a laptop for travel")).toBe("single_fact");
    expect(intentFor("any advice on which espresso machine to buy")).toBe("single_fact");
    expect(intentFor("help me find a good pour-over kettle")).toBe("single_fact");
    expect(intentFor("what should I order at the cafe")).toBe("single_fact");
    expect(intentFor("求推荐一款适合家用的咖啡机")).toBe("single_fact");
    expect(intentFor("给我一些关于咖啡豆的建议")).toBe("single_fact");
    expect(intentFor("what is my API key for service X")).toBe("single_fact");
  });
});
