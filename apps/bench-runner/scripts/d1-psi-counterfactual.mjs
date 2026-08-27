#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage:",
    "  node apps/bench-runner/scripts/d1-psi-counterfactual.mjs --artifact <recall-eval-diagnostics.json.gz> --out <report.json>"
  ].join("\n");
}

function readArg(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

const argv = process.argv.slice(2);
const artifact = readArg(argv, "--artifact");
const out = readArg(argv, "--out");
if (artifact === null || out === null) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

const diagnosticsUrl = pathToFileURL(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../dist/bench/diagnostics.js")
).href;
const { evaluateRecallEvalGzipD1Counterfactual } = await import(diagnosticsUrl);
const report = await evaluateRecallEvalGzipD1Counterfactual(path.resolve(artifact));
const outPath = path.resolve(out);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
