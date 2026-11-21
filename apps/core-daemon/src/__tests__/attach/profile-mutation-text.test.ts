import { describe, expect, it } from "vitest";
import { extractTomlBlock, removeTomlBlock } from "../../attach/profile-mutation/profile-mutation-text.js";

describe("profile mutation text", () => {
  it("extracts and removes the codex MCP server TOML block with Windows launcher paths", () => {
    const windowsPath = String.raw`D:\repo\bin\alaya.mjs`;
    const content = [
      "[other]",
      "enabled = true",
      "",
      "[mcp_servers.alaya]",
      'command = "node"',
      `args = ${JSON.stringify([windowsPath, "mcp", "stdio"])}`,
      "",
      "[after]",
      "keep = 1"
    ].join("\n");

    const extracted = extractTomlBlock(content, "[mcp_servers.alaya]");
    expect(extracted).toContain(`args = ${JSON.stringify([windowsPath, "mcp", "stdio"])}`);

    const removed = removeTomlBlock(content, "[mcp_servers.alaya]");
    expect(removed).not.toContain("[mcp_servers.alaya]");
    expect(removed).toContain("[other]");
    expect(removed).toContain("[after]");
  });
});
