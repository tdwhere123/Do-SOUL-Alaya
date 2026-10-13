import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeEntry } from "../../history/history.js";
import { buildPayload } from "../history/history-fixture.js";

const executable = fileURLToPath(new URL("../../../bin/alaya-eval.mjs", import.meta.url));
let root: string;

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "eval-executable-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function run(...args: string[]) {
  return spawnSync(process.execPath, [executable, ...args], { cwd: root, encoding: "utf8", timeout: 15_000 });
}

describe("built alaya-eval executable", () => {
  it("reads the cwd-local history by default and honors an explicit historical root", async () => {
    const current = { historyRoot: path.join(root, ".bench-artifacts/history") };
    const legacy = { historyRoot: path.join(root, "docs/bench-history") };
    const currentSlug = "2026-05-15T100000Z-aaaaaaa";
    const legacySlug = "2026-05-14T100000Z-bbbbbbb";
    await writeEntry(current, "self", currentSlug, buildPayload("aaaaaaa"), "report", null);
    await writeEntry(legacy, "self", legacySlug, buildPayload("bbbbbbb"), "report", null);
    const listed = run("list", "self");
    expect(listed.error).toBeUndefined();
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim()).toBe(currentSlug);
    const explicit = run("list", "self", "--history-root", "docs/bench-history");
    expect(explicit.status).toBe(0);
    expect(explicit.stdout.trim()).toBe(legacySlug);
    const diff = run("diff", "self");
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain("Alaya commit: aaaaaaa");
    expect(diff.stdout).not.toContain("bbbbbbb");
  });

  it("allows absent default history and refuses an explicitly missing diff input", () => {
    const listed = run("list", "self");
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim()).toBe("(no entries)");
    const absentDefault = run("diff", "self");
    expect(absentDefault.status).toBe(0);
    expect(absentDefault.stdout).toContain("no entries yet");
    const missing = path.join(root, "missing-history");
    const explicit = run("diff", "self", "--history-root", missing);
    expect(explicit.status).toBe(2);
    expect(explicit.stderr).toContain(`explicit history root does not exist: ${missing}`);
    expect(explicit.stdout).toBe("");
    expect(run("list", "self", "--history-root", missing).stdout.trim()).toBe("(no entries)");
  });

  it("refuses an explicitly empty comparison history without falling back to populated default history", async () => {
    await writeEntry({ historyRoot: path.join(root, ".bench-artifacts/history") }, "self",
      "2026-05-15T100000Z-aaaaaaa", buildPayload("aaaaaaa"), "report", null);
    const selected = path.join(root, "selected-empty");
    await mkdir(selected);
    const diff = run("diff", "self", "--history-root", selected);
    expect(diff.status).toBe(2);
    expect(diff.stderr).toContain(`explicit history has no comparison entries under ${path.join(selected, "self")}`);
    expect(diff.stdout).toBe("");
    const listed = run("list", "self", "--history-root", selected);
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim()).toBe("(no entries)");
    expect(run("diff", "self").stdout).toContain("Alaya commit: aaaaaaa");
  });
});
