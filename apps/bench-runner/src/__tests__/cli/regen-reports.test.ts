import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { buildPublicPayload, withAnswerRerank } from "../longmemeval/recall-eval/archive-fixture.js";

it("regenerates canonical legacy, policy and fast archives without changing KPI bytes or diagnostic qualification", () => {
  const root = mkdtempSync(join(tmpdir(), "regen-reports-"));
  try {
    const prior = payload(1, 0.8), other = { ...payload(2, 0.2), policy_shape: "chat" as const };
    const fastPrior = diagnostic(payload(3, 0.4, true)), current = payload(4, 0.9);
    const fastOther = diagnostic(payload(5, 0.2, true));
    fastOther.recall_eval_attribution = { ...fastOther.recall_eval_attribution!,
      answer_rerank: { enabled: true, provider_kind: "local_onnx_cross_encoder",
        effective_model_id: "different-treatment", model_artifact_sha256: "a".repeat(64) } };
    const fastCurrent = diagnostic(payload(6, 0.6, true));
    const entries: readonly [string, KpiPayload][] = [
      ["2026-05-01T100000Z-aaaaaaa", prior],
      ["2026-05-02T100000Z-bbbbbbb-policy-chat-report-none", other],
      ["2026-05-03T100000Z-ccccccc-policy-stress-recall-eval-snapshot", fastPrior],
      ["2026-05-04T100000Z-ddddddd-policy-stress-report-none", current],
      ["2026-05-05T100000Z-eeeeeee-policy-stress-recall-eval-snapshot", fastOther],
      ["2026-05-06T100000Z-fffffff-policy-stress-recall-eval-snapshot", fastCurrent]
    ];
    const bytes = new Map<string, string>();
    for (const [slug, value] of entries) {
      const dir = join(root, "public", slug); mkdirSync(dir, { recursive: true });
      const raw = JSON.stringify(value, null, 2) + "\n";
      bytes.set(slug, raw); writeFileSync(join(dir, "kpi.json"), raw);
      writeFileSync(join(dir, "report.md"), "stale report");
    }
    const ignored = join(root, "public", "not-a-history-entry"); mkdirSync(ignored);
    writeFileSync(join(ignored, "kpi.json"), "invalid");
    writeFileSync(join(ignored, "report.md"), "untouched");
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname,
      "../../../scripts/regen-reports.mjs"), root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    for (const [slug] of entries) expect(readFileSync(join(root, "public", slug, "kpi.json"), "utf8")).toBe(bytes.get(slug));
    const report = (index: number) => readFileSync(join(root, "public", entries[index]![0], "report.md"), "utf8");
    expect(report(0)).toContain("No previous baseline");
    expect(report(1)).toContain("No previous baseline");
    expect(report(3)).toContain("| r_at_5 | 0.8000 | 0.9000 |");
    expect(report(4)).toContain("No previous baseline");
    expect(report(5)).toContain("| r_at_5 | 0.4000 | 0.6000 |");
    expect(report(5)).toContain("Diagnostic only: measurement-ineligible and not release evidence.");
    expect(report(5)).toContain("Worst verdict: **INELIGIBLE**");
    expect(readFileSync(join(ignored, "report.md"), "utf8")).toBe("untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function payload(day: number, rAt5: number, recallEval = false): KpiPayload {
  return { ...buildPublicPayload({ commit: "a".repeat(7), rAt5, recallEval }),
    run_at: `2026-05-0${day}T10:00:00.000Z` };
}
function diagnostic(base: KpiPayload): KpiPayload {
  const value = withAnswerRerank(base, { enabled: false });
  return { ...value, recall_eval_attribution: { ...value.recall_eval_attribution!, gate_eligible: false } };
}
