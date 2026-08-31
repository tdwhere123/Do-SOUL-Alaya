import { describe, expect, it } from "vitest";
import {
  parseExtensionSkillPackage,
  parseExtensionToolProvider
} from "../../index.js";

const validTimestamp = "2026-04-20T08:00:00.000Z";

describe("extension descriptor parsers", () => {
  it("deep-freezes parsed tool providers", () => {
    const provider = parseExtensionToolProvider({
      provider_id: "provider.mcp.filesystem",
      name: "Filesystem MCP Provider",
      source: "mcp_external",
      tool_specs: [
        {
          tool_id: "mcp__filesystem__read_file",
          name: "filesystem.read_file",
          description: "Reads a file from the filesystem MCP server."
        }
      ],
      requires_permission_check: true,
      records_execution: true,
      registered_at: validTimestamp
    });

    expect(Object.isFrozen(provider)).toBe(true);
    expect(Object.isFrozen(provider.tool_specs)).toBe(true);
    expect(Object.isFrozen(provider.tool_specs[0])).toBe(true);
  });

  it("deep-freezes parsed skill packages", () => {
    const skillPackage = parseExtensionSkillPackage({
      skill_id: "skill.filesystem",
      name: "Filesystem Skill Package",
      version: "1.0.0",
      source: "skill_package",
      tool_ids: ["tools.read_file", "tools.write_file"],
      registered_at: validTimestamp
    });

    expect(Object.isFrozen(skillPackage)).toBe(true);
    expect(Object.isFrozen(skillPackage.tool_ids)).toBe(true);
  });
});
