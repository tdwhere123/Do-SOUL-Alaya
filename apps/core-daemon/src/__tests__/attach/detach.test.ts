import { describe, expect, it } from "vitest";
import { createDetachCommandSpec } from "../../cli/attach/detach.js";
import {
  applyProfileMutationPlan,
  buildAttachProfileMutationPlan
} from "../../attach/profile-mutation.js";
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
    expect(fs.files.get("/tmp/home/.codex/slash-commands.toml")).not.toContain("inspect --open");
    expect(auditWriter.rows).toHaveLength(1);
    expect(result.json).toMatchObject({
      ok: true,
      target: "codex",
      changed: true
    });
  });

  it("exposes searched candidate paths when nothing to detach", async () => {
    const fs = new MemoryProfileFs();
    const auditWriter = new MemoryProfileAuditWriter();
    const command = createDetachCommandSpec({
      fs,
      auditWriter,
      nowIso: () => "2026-04-30T00:00:00.000Z"
    });
    const ctx = createProfileCommandContext();
    const stdoutChunks: string[] = [];
    ctx.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));

    const result = await command.handler(ctx, ["codex", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(auditWriter.rows).toHaveLength(0);
    expect(result.json).toMatchObject({
      ok: true,
      target: "codex",
      changed: false,
      searched: [
        "/tmp/home/.codex/slash-commands.toml",
        "/tmp/home/.codex/commands/slash-commands.toml"
      ]
    });
    const stdoutText = stdoutChunks.join("");
    expect(stdoutText).toContain("nothing to detach");
    expect(stdoutText).toContain("searched paths:");
    expect(stdoutText).toContain("/tmp/home/.codex/slash-commands.toml");
    expect(stdoutText).toContain("/tmp/home/.codex/commands/slash-commands.toml");
  });

  it("rejects detach when slash alias has been hand-edited to a different command", async () => {
    const fs = new MemoryProfileFs();
    const setupPlan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home" },
      fs
    });
    await applyProfileMutationPlan(setupPlan, { fs, allowConflicts: true });
    const tamperedSlash = (fs.files.get("/tmp/home/.codex/slash-commands.toml") ?? "").replace(
      /^command = ".*inspect --open"$/mu,
      'command = "do not touch"'
    );
    fs.files.set("/tmp/home/.codex/slash-commands.toml", tamperedSlash);

    const auditWriter = new MemoryProfileAuditWriter();
    const command = createDetachCommandSpec({
      fs,
      auditWriter,
      nowIso: () => "2026-04-30T00:00:00.000Z"
    });

    const result = await command.handler(createProfileCommandContext(), ["codex", "--yes"]);

    expect(result.exitCode).not.toBe(0);
    expect(auditWriter.rows).toHaveLength(0);
    expect(result.json).toMatchObject({
      ok: false,
      target: "codex",
      changed: false
    });
    const json = result.json as { conflicts: readonly { message: string; existing_command: string }[] };
    expect(json.conflicts.length).toBeGreaterThan(0);
    expect(json.conflicts[0]!.existing_command).toBe("do not touch");
    expect(fs.files.get("/tmp/home/.codex/slash-commands.toml")).toContain("do not touch");
  });

  it("lists default candidates when the custom slash path env was set at attach but absent at detach", async () => {
    const fs = new MemoryProfileFs();
    const customSlashPath = "/tmp/home/.codex/custom/my-slash.toml";
    const setupPlan = await buildAttachProfileMutationPlan("codex", {
      env: { HOME: "/tmp/home", ALAYA_CODEX_SLASH_COMMANDS_PATH: customSlashPath },
      fs
    });
    await applyProfileMutationPlan(setupPlan, { fs, allowConflicts: true });
    expect(fs.files.get(customSlashPath)).toContain("inspect --open");

    const auditWriter = new MemoryProfileAuditWriter();
    const command = createDetachCommandSpec({
      fs,
      auditWriter,
      nowIso: () => "2026-04-30T00:00:00.000Z"
    });
    const ctx = createProfileCommandContext({ HOME: "/tmp/home" });

    const result = await command.handler(ctx, ["codex", "--yes"]);

    expect(result.exitCode).toBe(0);
    // Without the env override, default slash candidates are searched, missing the custom file;
    // the alias drift remains untouched on the custom path so the operator can detect it.
    expect(fs.files.get(customSlashPath)).toContain("inspect --open");
    expect(result.json).toMatchObject({
      ok: true,
      target: "codex",
      searched: [
        "/tmp/home/.codex/slash-commands.toml",
        "/tmp/home/.codex/commands/slash-commands.toml"
      ]
    });
    const json = result.json as { searched: readonly string[] };
    expect(json.searched).not.toContain(customSlashPath);
  });
});
