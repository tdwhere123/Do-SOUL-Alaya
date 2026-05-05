import { describe, expect, it, vi } from "vitest";
import { createAttachClaudeCommandSpec } from "../cli/attach-claude.js";
import {
  createProfileCommandContext,
  MemoryProfileAuditWriter,
  MemoryProfileFs
} from "./profile-command-fixtures.js";

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
    expect(fs.files.get("/tmp/home/.claude.json")).toContain("\"alaya\"");
    expect(fs.files.get("/tmp/home/.claude/slash-commands.json")).toContain("bin/alaya.mjs");
    expect(fs.files.get("/tmp/home/.claude/slash-commands.json")).toContain("inspect --open");
    expect(auditWriter.rows).toHaveLength(1);
    expect(trustStateRecorder.recordInstalled).toHaveBeenCalledWith("claude-code");
    expect(trustStateRecorder.recordConfigured).toHaveBeenCalledWith("claude-code");
  });
});
