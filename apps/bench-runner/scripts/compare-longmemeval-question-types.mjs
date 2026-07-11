#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
  return [
    "Usage:",
    "  node apps/bench-runner/scripts/compare-longmemeval-question-types.mjs \\",
    "    --dataset <longmemeval.json> --control <kpi.json> --treatment <kpi.json> \\",
    "    [--manifest <question-manifest.json>] [--json-out <file>] [--markdown-out <file>]",
    "    [--control-provenance <file>] [--treatment-provenance <file>]",
    "    [--allow-legacy-unattributed]",
    "",
    "Run `rtk pnpm --filter @do-soul/alaya-bench-runner build` first."
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    dataset: null,
    control: null,
    treatment: null,
    manifest: null,
    jsonOut: null,
    markdownOut: null,
    controlProvenance: null,
    treatmentProvenance: null,
    allowLegacyUnattributed: false
  };
  const fields = new Map([
    ["--dataset", "dataset"],
    ["--control", "control"],
    ["--treatment", "treatment"],
    ["--manifest", "manifest"],
    ["--json-out", "jsonOut"],
    ["--markdown-out", "markdownOut"],
    ["--control-provenance", "controlProvenance"],
    ["--treatment-provenance", "treatmentProvenance"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--allow-legacy-unattributed") {
      result.allowLegacyUnattributed = true;
      continue;
    }
    const field = fields.get(arg);
    if (field === undefined) throw new Error(`unknown argument: ${arg}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    result[field] = path.resolve(value);
  }
  for (const field of ["dataset", "control", "treatment"]) {
    if (result[field] === null) throw new Error(`--${field} is required`);
  }
  if (result.jsonOut !== null && result.jsonOut === result.markdownOut) {
    throw new Error("--json-out and --markdown-out must be different paths");
  }
  return result;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label} JSON at ${filePath}: ${String(error)}`);
  }
}

async function readJsonWithSha(filePath, label) {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      value: JSON.parse(raw),
      sha256: createHash("sha256").update(raw, "utf8").digest("hex")
    };
  } catch (error) {
    throw new Error(`failed to read ${label} JSON at ${filePath}: ${String(error)}`);
  }
}

async function readRunProvenance(explicitPath, kpiPath, label, allowLegacy) {
  const provenancePath = explicitPath ?? path.join(
    path.dirname(kpiPath),
    "longmemeval-run-provenance.json"
  );
  try {
    return JSON.parse(await readFile(provenancePath, "utf8"));
  } catch (error) {
    if (
      explicitPath === null &&
      allowLegacy &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) return undefined;
    throw new Error(
      `failed to read ${label} provenance JSON at ${provenancePath}: ${String(error)}`
    );
  }
}

async function loadComparisonModule() {
  try {
    return await import("../dist/longmemeval/comparison/question-type-comparison.js");
  } catch (error) {
    throw new Error(`comparison module is not built; run the bench-runner build first: ${String(error)}`);
  }
}

async function emit(contents, outputPath) {
  if (outputPath === null) {
    process.stdout.write(contents);
    return;
  }
  await writeFile(outputPath, contents, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [{ compareLongMemEvalQuestionTypes, renderQuestionTypeComparisonMarkdown }, datasetInput, control, treatment, controlProvenance, treatmentProvenance] =
    await Promise.all([
      loadComparisonModule(),
      readJsonWithSha(args.dataset, "dataset"),
      readJson(args.control, "control"),
      readJson(args.treatment, "treatment"),
      readRunProvenance(
        args.controlProvenance,
        args.control,
        "control",
        args.allowLegacyUnattributed
      ),
      readRunProvenance(
        args.treatmentProvenance,
        args.treatment,
        "treatment",
        args.allowLegacyUnattributed
      )
    ]);
  const manifestInput = args.manifest === null
    ? undefined
    : await readJsonWithSha(args.manifest, "manifest");
  const comparison = compareLongMemEvalQuestionTypes({
    dataset: datasetInput.value,
    datasetSha256: datasetInput.sha256,
    control,
    treatment,
    controlProvenance,
    treatmentProvenance,
    allowLegacyUnattributed: args.allowLegacyUnattributed,
    ...(manifestInput === undefined
      ? {}
      : {
          manifest: manifestInput.value,
          manifestFileSha256: manifestInput.sha256
        })
  });
  const json = `${JSON.stringify(comparison, null, 2)}\n`;
  const markdown = renderQuestionTypeComparisonMarkdown(comparison);
  await emit(json, args.jsonOut);
  await emit(markdown, args.markdownOut);
}

main().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n\n${usage()}\n`);
  process.exitCode = 1;
});
