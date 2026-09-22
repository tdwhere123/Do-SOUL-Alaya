#!/usr/bin/env node
import { checkChangelogVersions } from "./ci/check-changelog-version.mjs";

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const tag = cliArgs[0] ?? process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF?.replace(/^refs\/tags\//u, "");

if (tag === undefined || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(tag)) {
  console.error("release version check requires a semver tag like v0.3.8");
  process.exitCode = 1;
} else {
  try {
    const checked = checkChangelogVersions(tag);
    console.log(`release version check ok: ${tag}, ${checked.packageCount} packages with independent Protocol/Gateway versions`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
