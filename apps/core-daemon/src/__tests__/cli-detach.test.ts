import { describe, expect, it } from "vitest";
import { createDetachCommandSpec } from "../cli/detach.js";
import {
  applyProfileMutationPlan,
  buildAttachProfileMutationPlan
} from "../profile-mutation.js";
import {
  createProfileCommandContext,
  MemoryProfileAuditWriter,
  MemoryProfileFs
} from "./profile-command-fixtures.js";

describe("cli detach", () => {
  it("removes Alaya profile records with preview/confirm plumbing bypassed by --yes", async () => {
    const fs = new MemoryProfileFs();
    const setupPlan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    await applyProfileMutationPlan(setupPlan, { fs, allowConflicts: true });
    const auditWriter = new MemoryProfileAuditWriter();
    const command = createDetachCommandSpec({
      fs,
      auditWriter,
      nowIso: () => "2026-04-30T00:00:00.000Z"
    });

    const result = await command.handler(createProfileCommandContext(), ["codex", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(fs.files.get("/tmp/home/.codex/config.toml")).not.toContain("alaya");
    expect(fs.files.get("/tmp/home/.codex/slash-commands.toml")).not.toContain("alaya inspect --open");
    expect(auditWriter.rows).toHaveLength(1);
    expect(result.json).toMatchObject({
      ok: true,
      target: "codex",
      changed: true
    });
  });
});
