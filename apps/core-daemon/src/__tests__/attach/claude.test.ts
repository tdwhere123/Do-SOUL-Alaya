import { describe, expect, it, vi } from "vitest";
import { createAttachClaudeCommandSpec } from "../../cli/attach/claude.js";
import {
  createProfileCommandContext,
  MemoryProfileAuditWriter,
  MemoryProfileFs
} from "./profile-command-fixtures.js";
import { slashCommandContainsAlayaBin, claudeJsonPath, claudeSlashCommandsPath } from "../support/profile-test-home.js";

describe("attach claude", () => {
  it("writes MCP/slash profile records, audits, and records trust state", async () => {
    const fs = new MemoryProfileFs();
    const auditWriter = new MemoryProfileAuditWriter();
    const trustStateRecorder = {
      recordInstalled: vi.fn(async () => {}),
      recordConfigured: vi.fn(async () => {})
    };
    const command = createAttachClaudeCommandSpec({
      fs,
      auditWriter,
      trustStateRecorder,
      nowIso: () => "2026-04-30T00:00:00.000Z"
    });

    const result = await command.execute({
      ...createProfileCommandContext(),
      yes: true
    });

    expect(result.exitCode).toBe(0);
    expect(fs.files.get(claudeJsonPath())).toContain("\"alaya\"");
    expect(slashCommandContainsAlayaBin(fs.files.get(claudeSlashCommandsPath()) ?? "")).toBe(true);
    expect(fs.files.get(claudeSlashCommandsPath())).toContain("inspect --open");
    expect(auditWriter.rows).toHaveLength(1);
    expect(trustStateRecorder.recordInstalled).toHaveBeenCalledWith("claude-code");
    expect(trustStateRecorder.recordConfigured).toHaveBeenCalledWith("claude-code");
  });
});
