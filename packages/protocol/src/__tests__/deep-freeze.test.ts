import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shared deep freeze helper adoption", () => {
  it("keeps node-template on the shared protocol deepFreeze helper", () => {
    const nodeTemplateSource = readFileSync(
      new URL("../node-template.ts", import.meta.url),
      "utf8"
    );

    expect(nodeTemplateSource).toMatch(
      /import\s+\{\s*deepFreeze\s*\}\s+from\s+"\.\/deep-freeze\.js";/
    );
    expect(nodeTemplateSource).not.toMatch(/\bfunction\s+deepFreeze\s*</);
  });
});
