#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");

const tag =
  cliArgs[0] ??
  process.env.GITHUB_REF_NAME ??
  process.env.GITHUB_REF?.replace(/^refs\/tags\//u, "");

if (tag === undefined || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(tag)) {
  console.error("release version check requires a semver tag like v0.3.8");
  process.exit(1);
}

// App packages share the release tag semver; @do-soul/alaya-protocol tracks its
// own contract semver because MCP schema breaks are independent of app releases.
const PROTOCOL_PACKAGE = "@do-soul/alaya-protocol";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;

const expectedVersion = tag.slice(1);
const packageJsonPaths = [
  "package.json",
  ...listPackageJsons("packages"),
  ...listPackageJsons("apps")
].sort();

const mismatches = [];
const protocolIssues = [];
for (const packageJsonPath of packageJsonPaths) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name === PROTOCOL_PACKAGE) {
    if (
      typeof packageJson.version !== "string" ||
      !SEMVER_PATTERN.test(packageJson.version)
    ) {
      protocolIssues.push(`${packageJsonPath}: ${packageJson.version ?? "<missing>"}`);
    }
    continue;
  }
  if (packageJson.version !== expectedVersion) {
    mismatches.push(`${packageJsonPath}: ${packageJson.version ?? "<missing>"}`);
  }
}

if (protocolIssues.length > 0) {
  console.error(`${PROTOCOL_PACKAGE} must declare a valid semver version:`);
  for (const issue of protocolIssues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

if (mismatches.length > 0) {
  console.error(`release tag ${tag} does not match package version ${expectedVersion}:`);
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(
  `release version check ok: ${tag} matches ${packageJsonPaths.length - 1} app package.json files; ${PROTOCOL_PACKAGE} semver validated separately`
);

function listPackageJsons(root) {
  if (!existsSync(root)) return [];
  const results = [];
  visit(root, 0, results);
  return results;
}

function visit(dir, depth, results) {
  if (depth > 2) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const child = join(dir, entry.name);
    const packageJson = join(child, "package.json");
    if (existsSync(packageJson)) {
      results.push(packageJson);
    }
    visit(child, depth + 1, results);
  }
}
