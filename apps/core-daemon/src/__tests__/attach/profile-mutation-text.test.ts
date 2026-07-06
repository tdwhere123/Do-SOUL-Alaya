import { describe, expect, it } from "vitest";
import { extractCodexSlashCommand } from "../../attach/profile-mutation-text.js";

describe("profile mutation text", () => {
  it("extracts codex slash commands from JSON-escaped Windows paths in TOML", () => {
    const windowsPath = String.raw`D:\repo\bin\alaya.mjs`;
    const slashCommand = `node '${windowsPath}' inspect --open`;
    const content = [
      "[slash_commands.alaya-inspect]",
      `command = ${JSON.stringify(slashCommand)}`,
      `description = ${JSON.stringify("Open the Alaya Memory Inspector.")}`
    ].join("\n");

    expect(extractCodexSlashCommand(content)).toBe(slashCommand);
  });
});
