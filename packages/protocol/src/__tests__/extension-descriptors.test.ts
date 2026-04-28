import { describe, expect, it } from "vitest";
import {
  AgentProfileSchema,
  ExtensionSourceSchema,
  HookPolicySchema,
  IntegrationDescriptorSchema,
  McpServerInfoSchema,
  SkillPackageSchema,
  ToolProviderSchema
} from "../index.js";

const validTimestamp = "2026-04-20T08:00:00.000Z";

describe("extension descriptor schemas", () => {
  it("parses all C-9 extension descriptor contracts", () => {
    expect(ExtensionSourceSchema.parse("builtin")).toBe("builtin");
    expect(ExtensionSourceSchema.parse("mcp_external")).toBe("mcp_external");
    expect(ExtensionSourceSchema.parse("skill_package")).toBe("skill_package");
    expect(ExtensionSourceSchema.parse("user_configured")).toBe("user_configured");

    expect(
      SkillPackageSchema.parse({
        skill_id: "skill.filesystem",
        name: "Filesystem Skill Package",
        version: "1.0.0",
        source: "skill_package",
        tool_ids: ["tools.read_file", "tools.write_file"],
        registered_at: validTimestamp
      })
    ).toEqual({
      skill_id: "skill.filesystem",
      name: "Filesystem Skill Package",
      version: "1.0.0",
      source: "skill_package",
      tool_ids: ["tools.read_file", "tools.write_file"],
      registered_at: validTimestamp
    });

    expect(
      ToolProviderSchema.parse({
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
      })
    ).toEqual({
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

    expect(
      HookPolicySchema.parse({
        policy_id: "policy.pretool.audit",
        hook_type: "pre_tool_use",
        target_pattern: "mcp__filesystem__*",
        action: "audit",
        registered_at: validTimestamp
      })
    ).toEqual({
      policy_id: "policy.pretool.audit",
      hook_type: "pre_tool_use",
      target_pattern: "mcp__filesystem__*",
      action: "audit",
      registered_at: validTimestamp
    });

    expect(
      AgentProfileSchema.parse({
        agent_id: "agent.principal",
        name: "Principal Agent",
        capabilities: ["reasoning", "tool_use"],
        tool_access: ["provider.mcp.filesystem"],
        registered_at: validTimestamp
      })
    ).toEqual({
      agent_id: "agent.principal",
      name: "Principal Agent",
      capabilities: ["reasoning", "tool_use"],
      tool_access: ["provider.mcp.filesystem"],
      registered_at: validTimestamp
    });

    expect(
      IntegrationDescriptorSchema.parse({
        integration_id: "integration.github",
        name: "GitHub MCP",
        integration_type: "mcp_server",
        endpoint: "http://127.0.0.1:3040/mcp",
        status: "active",
        registered_at: validTimestamp
      })
    ).toEqual({
      integration_id: "integration.github",
      name: "GitHub MCP",
      integration_type: "mcp_server",
      endpoint: "http://127.0.0.1:3040/mcp",
      status: "active",
      registered_at: validTimestamp
    });

    expect(
      McpServerInfoSchema.parse({
        server_name: "filesystem",
        transport_type: "stdio",
        status: "active",
        registered_at: validTimestamp
      })
    ).toEqual({
      server_name: "filesystem",
      transport_type: "stdio",
      status: "active",
      registered_at: validTimestamp
    });

    expect(
      McpServerInfoSchema.parse({
        server_name: "github",
        transport_type: "http",
        endpoint: "http://127.0.0.1:3040/mcp",
        status: "inactive",
        registered_at: validTimestamp
      })
    ).toEqual({
      server_name: "github",
      transport_type: "http",
      endpoint: "http://127.0.0.1:3040/mcp",
      status: "inactive",
      registered_at: validTimestamp
    });
  });

  it("rejects malformed extension descriptor payloads", () => {
    expect(() =>
      SkillPackageSchema.parse({
        skill_id: "",
        name: "Invalid",
        version: "1.0.0",
        source: "skill_package",
        tool_ids: ["tools.read_file"],
        registered_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      ToolProviderSchema.parse({
        provider_id: "provider.mcp.invalid",
        name: "Invalid Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "",
            name: "invalid",
            description: "invalid"
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      HookPolicySchema.parse({
        policy_id: "policy.invalid",
        hook_type: "before_tool",
        target_pattern: "tools.*",
        action: "allow",
        registered_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      IntegrationDescriptorSchema.parse({
        integration_id: "integration.invalid",
        name: "Invalid Integration",
        integration_type: "ssh",
        status: "active",
        registered_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      McpServerInfoSchema.parse({
        server_name: "filesystem",
        transport_type: "http",
        status: "active",
        registered_at: "not-a-timestamp"
      })
    ).toThrow();
  });

  it("rejects overlong external descriptor fields", () => {
    expect(() =>
      ToolProviderSchema.parse({
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "m".repeat(257),
            name: "filesystem.read_file",
            description: "Reads a file from the filesystem MCP server."
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      ToolProviderSchema.parse({
        provider_id: "provider.mcp.filesystem",
        name: "Filesystem MCP Provider",
        source: "mcp_external",
        tool_specs: [
          {
            tool_id: "mcp__filesystem__read_file",
            name: "filesystem.read_file",
            description: "d".repeat(4097)
          }
        ],
        requires_permission_check: true,
        records_execution: true,
        registered_at: validTimestamp
      })
    ).toThrow();
  });

  it("accepts https and trusted local http endpoints only", () => {
    expect(
      IntegrationDescriptorSchema.parse({
        integration_id: "integration.remote",
        name: "Remote GitHub MCP",
        integration_type: "mcp_server",
        endpoint: "https://api.example.com/mcp",
        status: "active",
        registered_at: validTimestamp
      })
    ).toMatchObject({
      endpoint: "https://api.example.com/mcp"
    });

    expect(
      McpServerInfoSchema.parse({
        server_name: "filesystem",
        transport_type: "http",
        endpoint: "http://localhost:3040/mcp",
        status: "active",
        registered_at: validTimestamp
      })
    ).toMatchObject({
      endpoint: "http://localhost:3040/mcp"
    });

    expect(
      IntegrationDescriptorSchema.parse({
        integration_id: "integration.loopback-ipv6",
        name: "Loopback IPv6 MCP",
        integration_type: "mcp_server",
        endpoint: "http://[::1]:3040/mcp",
        status: "active",
        registered_at: validTimestamp
      })
    ).toMatchObject({
      endpoint: "http://[::1]:3040/mcp"
    });

    expect(() =>
      IntegrationDescriptorSchema.parse({
        integration_id: "integration.remote-http",
        name: "Remote HTTP MCP",
        integration_type: "mcp_server",
        endpoint: "http://example.com/mcp",
        status: "active",
        registered_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      McpServerInfoSchema.parse({
        server_name: "filesystem",
        transport_type: "http",
        endpoint: "ftp://127.0.0.1:3040/mcp",
        status: "active",
        registered_at: validTimestamp
      })
    ).toThrow();
  });
});
