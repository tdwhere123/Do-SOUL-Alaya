import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { soulToolDefs } from "../provider/soul-tool-specs.js";

describe("semver-tool-surface", () => {
  it("snapshots the public MCP tool names and description hashes", () => {
    expect(
      soulToolDefs
        .map((tool) => `${tool.name}|desc16=${sha256(tool.description).slice(0, 16)}`)
        .sort()
        .join("\n")
    ).toMatchSnapshot();
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
