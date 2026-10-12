#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { arch, platform, version } from "node:process";
import { fileURLToPath } from "node:url";
import { VITEST_PROJECT_GROUPS } from "./vitest-projects.mjs";

if (process.argv.includes("--self-test")) {
  process.exit(runSelfTest());
}

const group = required("--group");
const label = required("--label");
const status = required("--status");
const output = required("--output");
const projectsFile = arg("--projects-file") ?? process.env.ALAYA_SHARD_PROJECTS;
const shard = arg("--shard");
const expected = VITEST_PROJECT_GROUPS[group];
if (expected === undefined) {
  console.error(`unknown vitest project group ${group}`);
  process.exit(1);
}
let projects = [];
if (projectsFile !== undefined && projectsFile.length > 0) {
  try {
    projects = JSON.parse(readFileSync(projectsFile, "utf8")).projects ?? [];
  } catch {
    projects = [];
  }
}
const complete = projects.length === expected.length && projects.every((project, index) => project === expected[index]);
const recorded = status === "success" && !complete ? "incomplete" : status;
const manifest = { label, group, status: recorded, projects, platform, arch, node: version };
if (shard !== undefined && shard.length > 0) manifest.shard = shard;
writeFileSync(output, `${JSON.stringify(manifest)}\n`);
if (recorded !== "success") {
  console.error(
    `shard manifest ${recorded}: expected ${expected.join(", ")}, got ${projects.join(", ") || "(none)"}`
  );
  process.exitCode = 1;
}

function required(name) {
  const value = arg(name);
  if (value === undefined) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

function arg(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((entry) => entry.startsWith(prefix));
  return found?.slice(prefix.length);
}

function runSelfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "shard-handoff-"));
  const projectsFile = path.join(root, "projects.json");
  const output = path.join(root, "shard-manifest.json");
  writeFileSync(projectsFile, `${JSON.stringify({ projects: ["@do-soul/alaya-bench-runner"] })}\n`);
  const env = { ...process.env };
  delete env.ALAYA_SHARD_PROJECTS;
  const script = fileURLToPath(import.meta.url);
  const shared = spawnSync(process.execPath, [
    script,
    "--group=bench-runner",
    "--label=ubuntu-node24",
    "--status=success",
    `--projects-file=${projectsFile}`,
    `--output=${output}`
  ], { env, encoding: "utf8" });
  const missing = spawnSync(process.execPath, [
    script,
    "--group=bench-runner",
    "--label=ubuntu-node24",
    "--status=success",
    `--projects-file=${path.join(root, "missing.json")}`,
    `--output=${path.join(root, "missing-manifest.json")}`
  ], { env, encoding: "utf8" });
  try {
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    const failedManifest = JSON.parse(readFileSync(path.join(root, "missing-manifest.json"), "utf8"));
    if (shared.status !== 0 || manifest.status !== "success" || manifest.projects.length !== 1) {
      console.error("write-shard-manifest --self-test: explicit projects file was not shared", shared.stderr, manifest);
      return 1;
    }
    if (missing.status === 0 || failedManifest.status !== "incomplete" || !missing.stderr.includes("(none)")) {
      console.error("write-shard-manifest --self-test: empty manifest was treated as success", missing.stderr, failedManifest);
      return 1;
    }
    console.log("write-shard-manifest --self-test: ok");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
