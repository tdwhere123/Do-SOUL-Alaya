import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each(["missing", "malformed"])("does not emit measured-zero metrics for a %s archive", kind => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-quality-"));
  try {
    const archive = path.join(root, "archive.json");
    if (kind === "malformed") writeFileSync(archive, "{invalid");
    const script = path.resolve(import.meta.dirname, "../../../../../scripts/compute-bench-quality-metrics.mjs");
    const result = spawnSync(process.execPath, [script, archive], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed to read archive:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
