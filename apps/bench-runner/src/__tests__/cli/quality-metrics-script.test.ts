import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  { gold_memory_ids: ["memory"], gold_evidence_ids: ["capsule"], gold_object_ids: ["memory", "capsule"] },
  { gold_memory_ids: ["memory"], gold_evidence_ids: ["capsule"] },
  { gold_memory_ids: ["capsule"] }
])("counts capsule and legacy memory gold identities in both archive scripts: %j", identities => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-gold-cohort-"));
  try {
    const archive = path.join(root, "archive.json");
    writeFileSync(archive, JSON.stringify({ questions: [{
      ...identities,
      delivered_results: [{ object_id: "capsule", plane_first_admitted: "workspace_local",
        plane_winning_admission: "workspace_local" }]
    }] }));
    const scripts = path.resolve(import.meta.dirname, "../../../../../scripts");
    const cohort = spawnSync(process.execPath, [path.join(scripts, "compute-cohort-from-archive.mjs"), archive], { encoding: "utf8" });
    expect(cohort.status, cohort.stderr).toBe(0);
    expect(cohort.stdout).toContain("Total gold hits: 1");
    const quality = spawnSync(process.execPath, [path.join(scripts, "compute-bench-quality-metrics.mjs"), archive], { encoding: "utf8" });
    expect(quality.status, quality.stderr).toBe(0);
    const metrics = JSON.parse(quality.stdout);
    expect(metrics.cohort_first_admitted.workspace_local).toMatchObject({ gold_hit_count: 1, gold_hit_denominator: 1 });
    expect(metrics.cohort_winning_admission.workspace_local).toMatchObject({ gold_hit_count: 1, gold_hit_denominator: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
