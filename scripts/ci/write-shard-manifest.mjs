#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { arch, platform, version } from "node:process";
import { VITEST_PROJECT_GROUPS } from "./vitest-projects.mjs";

const group = required("--group");
const label = required("--label");
const status = required("--status");
const output = required("--output");
const projectsFile = process.env.ALAYA_SHARD_PROJECTS;
const expected = VITEST_PROJECT_GROUPS[group];
if (expected === undefined) {
  console.error(`unknown vitest project group ${group}`);
  process.exit(1);
}
let projects = [];
if (projectsFile !== undefined) {
  try {
    projects = JSON.parse(readFileSync(projectsFile, "utf8")).projects ?? [];
  } catch {
    projects = [];
  }
}
const complete = projects.length === expected.length && projects.every((project, index) => project === expected[index]);
const recorded = status === "success" && !complete ? "incomplete" : status;
writeFileSync(output, `${JSON.stringify({
  label,
  group,
  status: recorded,
  projects,
  platform,
  arch,
  node: version
})}\n`);
if (recorded !== "success") process.exitCode = 1;

function required(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (found === undefined) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return found.slice(prefix.length);
}
