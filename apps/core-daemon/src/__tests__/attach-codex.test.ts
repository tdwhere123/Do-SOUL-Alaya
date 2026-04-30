import { describe, expect, it, vi } from "vitest";
import { createAttachCodexCommandSpec } from "../cli/attach-codex.js";
import {
  createProfileCommandContext,
  MemoryProfileAuditWriter,
  MemoryProfileFs
} from "./profile-command-fixtures.js";

describe("attach codex", () => {
  it("writes MCP/slash profile records, audits, and records trust state", async () => {
    const fs = new MemoryProfileFs();
    const auditWriter = new MemoryProfileAuditWriter();
    const trustStateRecorder = {
      recordInstalled: vi.fn(async () => {}),
      recordConfigured: vi.fn(async () => {})
    };
    const command = createAttachCodexCommandSpec({
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
    expect(fs.files.get("/tmp/home/.codex/config.toml")).toContain("[mcp_servers.alaya]");
    expect(fs.files.get("/tmp/home/.codex/slash-commands.toml")).toContain("alaya inspect --open");
    expect(auditWriter.rows).toHaveLength(1);
    expect(trustStateRecorder.recordInstalled).toHaveBeenCalledWith("codex");
    expect(trustStateRecorder.recordConfigured).toHaveBeenCalledWith("codex");
  });
});
