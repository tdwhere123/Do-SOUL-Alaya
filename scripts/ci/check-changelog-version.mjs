#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const changelogPath = "CHANGELOG.md";
if (!existsSync(changelogPath)) {
  console.error("CHANGELOG.md is required");
  process.exit(1);
}

const changelog = readFileSync(changelogPath, "utf8");
const publishedHeadings = [...changelog.matchAll(/^## (v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\b/gmu)].map(
  (match) => match[1]
);
const latestPublished = publishedHeadings[0];

if (latestPublished === undefined) {
  console.error("CHANGELOG.md must contain at least one published ## vX.Y.Z section");
  process.exit(1);
}

if (/^## Unreleased\b/mu.test(changelog) && changelog.includes("Do not tag `Unreleased`") === false) {
  console.warn("changelog-version: Unreleased section present; ensure release policy is documented");
}

const expectedVersion = latestPublished.slice(1);
const packageJsonPaths = [
  "package.json",
  ...listPackageJsons("packages"),
  ...listPackageJsons("apps")
].sort();

const mismatches = [];
for (const packageJsonPath of packageJsonPaths) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name === "@do-soul/alaya-protocol") {
    continue;
  }
  if (packageJson.version !== expectedVersion) {
    mismatches.push(`${packageJsonPath}: ${packageJson.version ?? "<missing>"} (expected ${expectedVersion})`);
  }
}

if (mismatches.length > 0) {
  console.error(
    `App package versions must match latest published CHANGELOG section ${latestPublished}:`
  );
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  process.exit(1);
}

console.log(
  `check-changelog-version: ok (${latestPublished} matches ${packageJsonPaths.length - 1} app package.json files)`
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
