import { describe, expect, it } from "vitest";
import type { ToolSpec } from "@do-what/protocol";
import { getNonStreamingTools } from "../provider/internal/ai-sdk-helpers.js";
import { buildConversationToolDefs } from "../provider/conversation-tool-specs.js";
import { EXEC_SHELL_TOOL_SPEC } from "../tools/exec-shell-tool.js";
import { LIST_DIRECTORY_TOOL_SPEC } from "../tools/list-directory-tool.js";
import { READ_FILE_TOOL_SPEC } from "../tools/read-file-tool.js";
import { SEARCH_FILES_TOOL_SPEC } from "../tools/search-files-tool.js";
import { WRITE_FILE_TOOL_SPEC } from "../tools/write-file-tool.js";

const builtinConversationToolSpecs = Object.freeze([
  READ_FILE_TOOL_SPEC,
  LIST_DIRECTORY_TOOL_SPEC,
  SEARCH_FILES_TOOL_SPEC,
  WRITE_FILE_TOOL_SPEC,
  EXEC_SHELL_TOOL_SPEC
]);

function createExternalToolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    tool_id: "mcp__filesystem__read_file",
    category: "exec",
    description: "Read file through filesystem MCP.",
    scope_guard: "project",
    read_only: false,
    destructive: false,
    concurrency_safe: false,
    interrupt_behavior: "wait",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: false,
    ...overrides
  };
}

describe("conversation tool registry inputs", () => {
  it("builds a defensive copy from explicit builtin conversation tool specs", () => {
    const first = [...builtinConversationToolSpecs];
    const mutated = [...first];
    mutated.pop();

    expect(mutated).toHaveLength(4);
    expect(builtinConversationToolSpecs).toHaveLength(5);
  });

  it("materializes conversation tool defs from daemon-supplied specs", () => {
    const external = createExternalToolSpec({
      tool_id: "mcp__filesystem__search_files",
      description: "Search files through filesystem MCP."
    });

    const defs = buildConversationToolDefs([
      ...builtinConversationToolSpecs,
      external
    ]);

    expect(defs.map((def) => def.name)).toContain("mcp__filesystem__search_files");
    expect(defs.find((def) => def.name === "mcp__filesystem__search_files")).toMatchObject({
      description: "Search files through filesystem MCP."
    });
  });

  it("builds AI SDK tools from daemon-supplied conversation tool defs", () => {
    const external = createExternalToolSpec({
      tool_id: "mcp__filesystem__search_files",
      description: "Search files through filesystem MCP."
    });

    const aiSdkTools = getNonStreamingTools({
      conversationToolDefs: buildConversationToolDefs([
        ...builtinConversationToolSpecs,
        external
      ])
    });

    expect(Object.keys(aiSdkTools)).toContain("mcp__filesystem__search_files");
    expect(Object.keys(aiSdkTools)).toContain("soul.emit_candidate_signal");
  });

  it("uses protocol-owned schemas for built-in tools and a passthrough fallback for external tools", () => {
    const external = createExternalToolSpec({
      tool_id: "mcp__filesystem__search_files",
      description: "Search files through filesystem MCP."
    });

    const defs = buildConversationToolDefs([
      ...builtinConversationToolSpecs,
      external
    ]);

    const readFileSchema = defs.find((def) => def.name === "tools.read_file")?.parametersSchema;
    const externalSchema = defs.find((def) => def.name === "mcp__filesystem__search_files")?.parametersSchema;

    expect(readFileSchema).toBeDefined();
    expect(externalSchema).toBeDefined();
    expect(() => readFileSchema!.parse({ path: "src/index.ts" })).not.toThrow();
    expect(() => readFileSchema!.parse({ command: "ls" })).toThrow();
    expect(() => externalSchema!.parse({ command: "ls", recursive: true })).not.toThrow();
  });

  it("does not synthesize builtin conversation tools when daemon tool defs are omitted", () => {
    const aiSdkTools = getNonStreamingTools();

    expect(Object.keys(aiSdkTools)).toContain("soul.emit_candidate_signal");
    expect(Object.keys(aiSdkTools)).not.toContain("tools.read_file");
    expect(Object.keys(aiSdkTools)).not.toContain("tools.exec_shell");
  });
});
