import { describe, expect, it } from "vitest";
import { createDetachCommandSpec } from "../../cli/attach/detach.js";
import {
  applyProfileMutationPlan,
  buildAttachProfileMutationPlan
} from "../../attach/profile-mutation/profile-mutation.js";
import {
  createProfileCommandContext,
  MemoryProfileAuditWriter,
  MemoryProfileFs
} from "./profile-command-fixtures.js";
import { codexConfigPath, createProfileTestEnv } from "../support/profile-test-home.js";

describe("cli detach", () => {
  it("returns a failing exit status on cancellation so uninstall can report the retained attachment", async () => {
    const fs = new MemoryProfileFs();
    const setupPlan = await buildAttachProfileMutationPlan("codex", { env: createProfileTestEnv(), fs });
    await applyProfileMutationPlan(setupPlan, { fs });
    const before = fs.files.get(codexConfigPath());
    const command = createDetachCommandSpec({ fs, confirm: async () => false });
    const result = await command.handler(createProfileCommandContext(), ["codex"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({ ok: false, canceled: true, changed: false });
    expect(fs.files.get(codexConfigPath())).toBe(before);
  });

  it("removes Alaya profile records with preview/confirm plumbing bypassed by --yes", async () => {
    const fs = new MemoryProfileFs();
    const setupPlan = await buildAttachProfileMutationPlan("codex", {
      env: createProfileTestEnv(),
      fs
    });
    await applyProfileMutationPlan(setupPlan, { fs });
    const auditWriter = new MemoryProfileAuditWriter();
    const command = createDetachCommandSpec({
      fs,
      auditWriter,
      nowIso: () => "2026-04-30T00:00:00.000Z"
    });

    const result = await command.handler(createProfileCommandContext(), ["codex", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(fs.files.get(codexConfigPath())).not.toContain("alaya");
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
      searched: [codexConfigPath()]
    });
    const stdoutText = stdoutChunks.join("");
    expect(stdoutText).toContain("nothing to detach");
    expect(stdoutText).toContain("searched paths:");
    expect(stdoutText).toContain(codexConfigPath());
  });
});
