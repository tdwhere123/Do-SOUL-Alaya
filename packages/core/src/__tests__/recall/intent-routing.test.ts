import { afterEach, describe, expect, it } from "vitest";
import { classifyRecallIntent } from "../../recall/recall-query-plan.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";

const FLAG = "ALAYA_RECALL_INTENT_V2";
const intentFor = (query: string) => classifyRecallIntent(compileRecallQueryProbes(query));

afterEach(() => {
  delete process.env[FLAG];
});

describe("classifyRecallIntent ALAYA_RECALL_INTENT_V2", () => {
  it("flag OFF keeps recommend-style queries as single_fact (parity)", () => {
    delete process.env[FLAG];
    expect(intentFor("recommend a good coffee shop")).toBe("single_fact");
    expect(intentFor("can you suggest a restaurant for tonight")).toBe("single_fact");
  });

  it("flag ON routes recommendation/advice phrasings to preference", () => {
    process.env[FLAG] = "1";
    expect(intentFor("recommend a good coffee shop")).toBe("preference");
    expect(intentFor("would you recommend a laptop for travel")).toBe("preference");
    expect(intentFor("can you suggest a restaurant for tonight")).toBe("preference");
    expect(intentFor("any advice on which espresso machine to buy")).toBe("preference");
    expect(intentFor("help me find a good pour-over kettle")).toBe("preference");
    expect(intentFor("what should I order at the cafe")).toBe("preference");
    expect(intentFor("求推荐一款适合家用的咖啡机")).toBe("preference");
    expect(intentFor("给我一些关于咖啡豆的建议")).toBe("preference");
  });

  it("flag ON does not over-capture a single_fact lookup", () => {
    process.env[FLAG] = "1";
    expect(intentFor("what is my API key for service X")).toBe("single_fact");
    expect(intentFor("where is the warehouse located")).toBe("single_fact");
  });

  it("flag ON honours only truthy flag values", () => {
    process.env[FLAG] = "off";
    expect(intentFor("recommend a good coffee shop")).toBe("single_fact");
  });
});
