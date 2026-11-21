import { describe, expect, it, vi } from "vitest";
import { createAttachCodexCommandSpec } from "../../cli/attach/codex.js";
import {
  createProfileCommandContext,
  MemoryProfileAuditWriter,
  MemoryProfileFs
} from "./profile-command-fixtures.js";
import { codexConfigPath } from "../support/profile-test-home.js";

describe("attach codex", () => {
  it("writes MCP profile records, audits, and records trust state", async () => {
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
    expect(fs.files.get(codexConfigPath())).toContain("[mcp_servers.alaya]");
    expect(auditWriter.rows).toHaveLength(1);
    expect(trustStateRecorder.recordInstalled).toHaveBeenCalledWith("codex");
    expect(trustStateRecorder.recordConfigured).toHaveBeenCalledWith("codex");
  });
});
