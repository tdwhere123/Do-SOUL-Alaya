#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./append-bench-degradation-backlog.mjs", import.meta.url));
const slugA = "2026-05-15T080000Z-0bbbbbb";
const slugB = "2026-05-16T080000Z-0cccccc";

function writeFailingRun(historyRoot, slug, kpiRelPath = `${slug}/kpi.json`) {
  const archive = path.join(historyRoot, "public", slug);
  mkdirSync(archive, { recursive: true });
  writeFileSync(
    path.join(archive, "kpi.json"),
    JSON.stringify({
      diff_vs_previous: { r_at_5_delta_pp: -12, previous_run: "previous" },
      kpi: {}
    })
  );
  writeFileSync(
    path.join(historyRoot, "public", "latest-run.json"),
    JSON.stringify({ slug, kpi_path: kpiRelPath })
  );
}

function writeBacklog(backlogPath, nextId) {
  writeFileSync(
    backlogPath,
    [
      "# Benchmark degradation backlog",
      "",
      `**Next available number**: \`${nextId}\``,
      "",
      "## Open Issues",
      "",
      "No open `#BL-*` issues at this time.",
      ""
    ].join("\n")
  );
}

function run(historyRoot, backlogPath, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--history-root",
      historyRoot,
      "--bench",
      "public",
      "--backlog",
      backlogPath,
      "--threshold-pp",
      "5"
    ],
    { encoding: "utf8", env: { ...process.env, ...extraEnv } }
  );
}

test("opens #BL-999 and advances the next marker to #BL-1000", () => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-backlog-id-"));
  try {
    writeFailingRun(root, slugA);
    const backlogPath = path.join(root, "backlog.md");
    writeBacklog(backlogPath, "#BL-999");
    const first = run(root, backlogPath);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      action: "opened",
      issue: "#BL-999",
      slug: slugA,
      delta: -12
    });
    const afterFirst = readFileSync(backlogPath, "utf8");
    assert.match(afterFirst, /\*\*Next available number\*\*: `#BL-1000`/);
    assert.match(afterFirst, /### #BL-999 —/);

    writeFailingRun(root, slugB);
    const second = run(root, backlogPath);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).issue, "#BL-1000");
    const afterSecond = readFileSync(backlogPath, "utf8");
    assert.match(afterSecond, /\*\*Next available number\*\*: `#BL-1001`/);
    assert.match(afterSecond, /### #BL-1000 —/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects kpi_path traversal and symlink escapes outside the history root", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "alaya-backlog-path-"));
  const root = path.join(parent, "history");
  try {
    const backlogPath = path.join(root, "backlog.md");
    mkdirSync(root, { recursive: true });
    writeBacklog(backlogPath, "#BL-001");
    writeFailingRun(root, slugA, `..${path.sep}..${path.sep}etc${path.sep}passwd`);
    const traversal = run(root, backlogPath);
    assert.notEqual(traversal.status, 0);
    assert.match(`${traversal.stderr}\n${traversal.stdout}`, /kpi_path escapes repository root/);

    writeFailingRun(root, slugA, "/etc/passwd");
    const absolute = run(root, backlogPath);
    assert.notEqual(absolute.status, 0);
    assert.match(`${absolute.stderr}\n${absolute.stdout}`, /kpi_path escapes repository root/);

    const outsideDir = path.join(parent, "outside");
    mkdirSync(outsideDir);
    const outsideKpi = path.join(outsideDir, "kpi.json");
    writeFileSync(
      outsideKpi,
      JSON.stringify({ diff_vs_previous: { r_at_5_delta_pp: -12 }, kpi: {} })
    );
    writeFailingRun(root, slugA, `${slugA}/kpi.json`);
    const link = path.join(root, "public", slugA, "escaped.json");
    symlinkSync(outsideKpi, link);
    writeFileSync(
      path.join(root, "public", "latest-run.json"),
      JSON.stringify({ slug: slugA, kpi_path: `${slugA}/escaped.json` })
    );
    const linked = run(root, backlogPath);
    assert.notEqual(linked.status, 0);
    assert.match(`${linked.stderr}\n${linked.stdout}`, /kpi_path escapes repository root/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("exclusive backlog lockfile rejects a concurrent writer", () => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-backlog-lock-"));
  try {
    writeFailingRun(root, slugA);
    const backlogPath = path.join(root, "backlog.md");
    writeBacklog(backlogPath, "#BL-001");
    const lockPath = `${backlogPath}.lock`;
    writeFileSync(lockPath, "");
    const blocked = run(root, backlogPath);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /backlog lock exists/);
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath);
    const opened = run(root, backlogPath);
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(JSON.parse(opened.stdout).issue, "#BL-001");
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
