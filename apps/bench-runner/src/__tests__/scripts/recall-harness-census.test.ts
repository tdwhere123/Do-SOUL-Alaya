import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

const scripts = new URL("../../../scripts/", import.meta.url);

it("qualifies successful CLI scoring and invalidates prior success before malformed input reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-score-inputs-"));
  try {
    const data = join(root, "dataset.json"), census = join(root, "expected.json"), rows = join(root, "rows.jsonl");
    const snapshot = join(root, "snapshot.sqlite"), db = new Database(snapshot);
    db.exec("CREATE TABLE source_records(workspace_id TEXT, record_id TEXT, source_id TEXT, source_version TEXT, content_digest TEXT, source_body TEXT)");
    db.close();
    const good = new Map([
      [data, JSON.stringify([{ question_id: "empty", haystack_sessions: [[]] }])],
      [census, JSON.stringify({ question_ids: ["empty"], arms: ["base"], reader: "current", capture_pool: false })],
      [rows, JSON.stringify({ question_id: "empty", arm: "base", status: "complete", snapshot, workspace: "fixture", intervals: [] }) + "\n"]
    ]);
    const score = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL("recall-harness-score.mjs", scripts)),
      "--out", root, "--dataset", data, "--census", census]);
    for (const badInput of [data, rows, census, "invalid-census", "late-truncated-row", "missing-rows"]) {
      for (const [path, content] of good) writeFileSync(path, content);
      await score();
      const success = JSON.parse(readFileSync(join(root, "census.json"), "utf8"));
      expect(success.status).toBe("qualifiable");
      expect(success.by_arm[0]).toMatchObject({ expected: 1, complete: 1, unknown: 0, unanswerable: 1 });
      expect(success.inputs.rows.sha256).toBe(createHash("sha256").update(good.get(rows)!).digest("hex"));
      if (badInput === "missing-rows") rmSync(rows);
      else if (badInput === "late-truncated-row") {
        writeFileSync(rows, good.get(rows)! + JSON.stringify({ observation: "x".repeat(140000) }) + '\n{"truncated":');
      } else writeFileSync(badInput === "invalid-census" ? census : badInput, badInput === "invalid-census" ? "{}" : "not json");
      await expect(score()).rejects.toMatchObject({ code: 1 });
      expect(JSON.parse(readFileSync(join(root, "census.json"), "utf8")))
        .toMatchObject({ status: "not_qualifiable", reason: "scoring_incomplete" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const dataset = new Map([
  ["a", { question_id: "a", haystack_sessions: [[{ has_answer: true, content: "gold" }]] }],
  ["b", { question_id: "b", haystack_sessions: [[{ has_answer: true, content: "gold" }]] }],
  ["c", { question_id: "c", haystack_sessions: [[]] }]
]);
const manifest = { question_ids: ["a", "b", "c"], arms: ["base", "candidate"], reader: "end_continuation", capture_pool: true };
const complete = (question_id: string, arm: string) => ({ question_id, arm, status: "complete", reader: "end_continuation",
  end_continuation: { issues: [] }, capture_requested: true, pool_capture: { status: "captured", issues: [] } });

it("requires the fixed question by arm census, without treating unknowns as misses", async () => {
  const { recallHarnessCensus } = await import(new URL("recall-harness-census.mjs", scripts).href);
  const rows = manifest.question_ids.flatMap(id => manifest.arms.map(arm => complete(id, arm)));
  const ready = recallHarnessCensus(rows, dataset, manifest);
  expect(ready.status).toBe("qualifiable");
  expect(ready.expected_rows).toBe(6);
  expect(ready.by_arm).toEqual(manifest.arms.map(arm => ({ arm, expected: 3, answerable: 2,
    complete: 3, unknown: 0, unknown_answerable: 0, unanswerable: 1 })));
  const bad = [rows[0], rows[0], { ...rows[1], status: "failed" }, { ...rows[2], end_continuation: { issues: ["cut"] } },
    rows[3], rows[4], complete("unexpected", "candidate")];
  const result = recallHarnessCensus(bad, dataset, manifest);
  expect(result.status).toBe("not_qualifiable");
  expect(result.duplicates).toEqual([{ question_id: "a", arm: "base" }]);
  expect(result.unexpected).toEqual([{ question_id: "unexpected", arm: "candidate" }]);
  expect(result.missing).toEqual([{ question_id: "c", arm: "candidate" }]);
  expect(result.incomplete).toContainEqual({ question_id: "a", arm: "candidate", reasons: ["status_failed"] });
  expect(result.incomplete).toContainEqual({ question_id: "b", arm: "base", reasons: ["continuation_issues"] });
  expect(result.by_arm[1]).toMatchObject({ expected: 3, answerable: 2, unknown: 2, unknown_answerable: 1 });
  const withoutPool = rows.map((row, index) => index === 0 ? { ...row, pool_capture: { status: "unavailable", issues: [] } } : row);
  expect(recallHarnessCensus(withoutPool, dataset, manifest).incomplete)
    .toContainEqual({ question_id: "a", arm: "base", reasons: ["pool_capture_incomplete"] });
  expect(recallHarnessCensus(rows, dataset, undefined)).toMatchObject({ status: "not_qualifiable", reason: "expected_census_missing" });
  expect(() => recallHarnessCensus(rows, dataset, { ...manifest, question_ids: ["a", "a"] })).toThrow(/unique/u);
});

it("writes failure states and refuses qualification when an expected paired row fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-score-census-"));
  const scorer = fileURLToPath(new URL("recall-harness-score.mjs", scripts));
  try {
    const data = join(root, "dataset.json"), census = join(root, "expected.json");
    writeFileSync(data, JSON.stringify([dataset.get("a")]));
    writeFileSync(census, JSON.stringify({ question_ids: ["a"], arms: ["base", "candidate"], reader: "end_continuation", capture_pool: false }));
    writeFileSync(join(root, "rows.jsonl"), [
      { question_id: "a", arm: "base", question_type: "fixture", status: "unavailable" },
      { question_id: "a", arm: "candidate", question_type: "fixture", status: "failed" }
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const failure = await promisify(execFile)(process.execPath, [scorer, "--out", root, "--dataset", data, "--census", census, "--base", "base"])
      .then(() => { throw new Error("incomplete census must fail"); }, (error: Error & { code: number; stdout: string }) => error);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toContain("not_qualifiable");
    const report = JSON.parse(readFileSync(join(root, "census.json"), "utf8"));
    expect(report.by_arm.map((arm: { unknown: number }) => arm.unknown)).toEqual([1, 1]);
    const scores = readFileSync(join(root, "scores.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(scores.map((row: { status: string; scored: boolean }) => [row.status, row.scored]))
      .toEqual([["unavailable", false], ["failed", false]]);
    expect(scores.every((row: object) => !("msg5" in row))).toBe(true);

    // A complete census alone must not survive a later snapshot/scoring failure as a pass.
    writeFileSync(census, JSON.stringify({ question_ids: ["a"], arms: ["base"], reader: "current", capture_pool: false }));
    writeFileSync(join(root, "rows.jsonl"), JSON.stringify({ question_id: "a", arm: "base", status: "complete",
      snapshot: join(root, "missing.sqlite"), workspace: "fixture", intervals: [] }) + "\n");
    const scoringFailure = await promisify(execFile)(process.execPath, [scorer, "--out", root, "--dataset", data, "--census", census])
      .then(() => { throw new Error("missing snapshot must fail scoring"); }, (error: Error & { code: number }) => error);
    expect(scoringFailure.code).toBe(1);
    expect(JSON.parse(readFileSync(join(root, "census.json"), "utf8")))
      .toMatchObject({ status: "not_qualifiable", reason: "scoring_incomplete" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
