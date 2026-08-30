#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeRepositoryStructure,
  computeEntryExportSnapshots,
  computePrivateBarrelSnapshots,
  formatIssue
} from "./repository-structure-guard.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const options = parseArguments(process.argv.slice(2));
const root = path.resolve(options.root ?? repositoryRoot);
const policyPath = path.resolve(
  options.policy ?? path.join(repositoryRoot, "scripts/ci/repository-structure-policy.json")
);
const policy = JSON.parse(readFileSync(policyPath, "utf8"));

if (options.printExportSnapshots) {
  process.stdout.write(`${JSON.stringify(computeEntryExportSnapshots({ root, policy }), null, 2)}\n`);
  process.exit(0);
}
if (options.printPrivateBarrelSnapshots) {
  process.stdout.write(`${JSON.stringify(computePrivateBarrelSnapshots({ root, policy }), null, 2)}\n`);
  process.exit(0);
}

const result = analyzeRepositoryStructure({ root, policy });
for (const advisory of result.advisories) process.stdout.write(`${formatIssue(advisory)}\n`);
for (const error of result.errors) process.stderr.write(`${formatIssue(error)}\n`);
process.stdout.write(
  `repository-structure: files=${result.summary.files} ` +
  `advisories=${result.summary.advisories} errors=${result.summary.errors}\n`
);
process.exitCode = result.errors.length === 0 ? 0 : 1;

function parseArguments(argumentsList) {
  const options = {
    root: undefined,
    policy: undefined,
    printExportSnapshots: false,
    printPrivateBarrelSnapshots: false
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--root" || argument === "--policy") {
      const value = argumentsList[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      options[argument === "--root" ? "root" : "policy"] = value;
      index += 1;
      continue;
    }
    if (argument === "--print-export-snapshots") {
      options.printExportSnapshots = true;
      continue;
    }
    if (argument === "--print-private-barrel-snapshots") {
      options.printPrivateBarrelSnapshots = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}
