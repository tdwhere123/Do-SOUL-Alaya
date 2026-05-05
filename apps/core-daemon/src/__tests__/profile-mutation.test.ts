import { describe, expect, it } from "vitest";
import {
  ALAYA_OPERATOR_INSTRUCTIONS,
  ALAYA_SLASH_COMMAND,
  applyProfileMutationPlan,
  buildAttachProfileMutationPlan,
  buildDetachProfileMutationPlan,
  PUBLIC_SOUL_TOOL_NAMES,
  renderProfileMutationPreview,
  resolveAlayaSlashCommand,
  resolveProfilePaths,
  type ProfileMutationAuditRow,
  type ProfileMutationAuditWriter,
  type ProfileMutationFs
} from "../profile-mutation.js";

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
      "soul.apply_override",
      "soul.explore_graph",
      "soul.report_context_usage"
    ]);
    expect(ALAYA_OPERATOR_INSTRUCTIONS).not.toContain("memory.");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("tools-only");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("prompts/resources");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("soul.recall -> soul.open_pointer -> respond -> soul.report_context_usage");
    expect(ALAYA_OPERATOR_INSTRUCTIONS).toContain("soul.list_pending_proposals");
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
