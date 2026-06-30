import { afterEach, describe, expect, it } from "vitest";
import {
  composeRecallEnabled,
  type ActivationCandidate
} from "../../recall/activation-assembly.js";

const FLAG = "ALAYA_RECALL_COMPOSE";

afterEach(() => {
  delete process.env[FLAG];
});

describe("composeRecallEnabled", () => {
  it("defaults off when the flag is unset", () => {
    delete process.env[FLAG];
    expect(composeRecallEnabled()).toBe(false);
  });

  it("is on for truthy flag values and off otherwise", () => {
    for (const value of ["on", "1", "true"]) {
      process.env[FLAG] = value;
      expect(composeRecallEnabled()).toBe(true);
    }
    for (const value of ["off", "0", "false", ""]) {
      process.env[FLAG] = value;
      expect(composeRecallEnabled()).toBe(false);
    }
  });
});

describe("ActivationCandidate", () => {
  it("models an entity-keyed or standalone unit", () => {
    const entityUnit: ActivationCandidate = {
      key: "postgres",
      members: ["mem-1", "mem-2"],
      score: 0.9
    };
    const standalone: ActivationCandidate = { key: null, members: ["mem-3"], score: 0.5 };
    expect(entityUnit.key).toBe("postgres");
    expect(entityUnit.members).toEqual(["mem-1", "mem-2"]);
    expect(standalone.key).toBeNull();
  });
});
