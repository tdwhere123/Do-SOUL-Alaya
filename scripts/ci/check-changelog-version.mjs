#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** CI and release tags use the same independent MCP package-version declarations. */
export function checkChangelogVersions(releaseTag) {
  const changelogPath = "CHANGELOG.md";
  if (!existsSync(changelogPath)) {
    console.error("CHANGELOG.md is required");
    throw new Error("changelog version check failed");
  }

  const changelog = readFileSync(changelogPath, "utf8");
  if ([...changelog.matchAll(/^## Unreleased\b/gmu)].length > 1) {
    throw new Error("CHANGELOG.md must have at most one active Unreleased section");
  }
  const publishedHeadings = [...changelog.matchAll(/^## (v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\b/gmu)].map(
    (match) => match[1]
  );
  const latestPublished = publishedHeadings[0];

  if (latestPublished === undefined) {
    console.error("CHANGELOG.md must contain at least one published ## vX.Y.Z section");
    throw new Error("changelog version check failed");
  }

  if (/^## Unreleased\b/mu.test(changelog) && changelog.includes("Do not tag `Unreleased`") === false) {
    console.warn("changelog-version: Unreleased section present; ensure release policy is documented");
  }

  if (releaseTag !== undefined && releaseTag !== latestPublished) {
    throw new Error(`CHANGELOG.md latest published section is ${latestPublished}; tag ${releaseTag} requires a matching heading (Unreleased is not a release)`);
  }
  const expectedVersion = latestPublished.slice(1);
  const packageJsonPaths = [
    "package.json",
    ...listPackageJsons("packages"),
    ...listPackageJsons("apps")
  ].sort();

  // Declarations belong to the first Unreleased section, or the latest published
  // section when there is no Unreleased section. Older sections cannot override it.
  const declarations = changelog.match(/^## Unreleased\b[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu)?.[0]
    ?? changelog.match(/^## v\d+\.\d+\.\d+[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu)?.[0] ?? "";
  const protocolVersion = declarations.match(/protocol (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/u)?.[1];
  // Gateway has its own MCP-tool SemVer sidecar; validate the active
  // declaration rather than forcing it back to the app version after an API bump.
  const gatewayVersion = declarations.match(/`@do-soul\/alaya-engine-gateway` is\s*`(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)`/u)?.[1];
  const mismatches = [];
  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson.name === "@do-soul/alaya-protocol") {
      if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(packageJson.version)
        || !changelog.includes(`protocol ${packageJson.version}`)) {
        mismatches.push(`${packageJsonPath}: must declare valid semver recorded as protocol ${packageJson.version ?? "<missing>"} in CHANGELOG.md`);
      }
      if (protocolVersion === undefined) continue;
    }
    const expected = packageJson.name === "@do-soul/alaya-protocol" ? protocolVersion
      : packageJson.name === "@do-soul/alaya-engine-gateway" ? gatewayVersion ?? expectedVersion : expectedVersion;
    if (expected === undefined || packageJson.version !== expected) {
      mismatches.push(`${packageJsonPath}: ${packageJson.version ?? "<missing>"} (expected ${expected ?? "an active protocol declaration"})`);
    }
  }

  if (mismatches.length > 0) {
    console.error(
      `Package versions must match CHANGELOG (app ${latestPublished}, independently declared MCP packages):`
    );
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    throw new Error("changelog version check failed");
  }

  return { packageCount: packageJsonPaths.length, latestPublished };

}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const checked = checkChangelogVersions();
    console.log(`check-changelog-version: ok (${checked.packageCount} packages; app ${checked.latestPublished}, explicit Protocol/Gateway versions)`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

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
