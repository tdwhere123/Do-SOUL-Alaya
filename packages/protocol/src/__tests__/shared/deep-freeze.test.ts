import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deepFreeze } from "../../shared/deep-freeze.js";

describe("shared deep freeze helper adoption", () => {
  it("keeps node-template on the shared protocol deepFreeze helper", () => {
    const nodeTemplateSource = readFileSync(
      new URL("../../runtime/node-template.ts", import.meta.url),
      "utf8"
    );

    expect(nodeTemplateSource).toMatch(
      /import\s+\{\s*deepFreeze\s*\}\s+from\s+"\.\.\/shared\/deep-freeze\.js";/
    );
    expect(nodeTemplateSource).not.toMatch(/\bfunction\s+deepFreeze\s*</);
  });

  it("freezes cyclic object graphs without overflowing the stack", () => {
    const value: { self?: unknown } = {};
    value.self = value;

    const frozen = deepFreeze(value);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.self).toBe(frozen);
  });
});
