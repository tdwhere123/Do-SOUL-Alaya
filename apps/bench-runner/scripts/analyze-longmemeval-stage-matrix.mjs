#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadStageMatrix, renderStageMatrix } from "./longmemeval-replay/stage-matrix.mjs";

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return;
  const output = renderStageMatrix(await loadStageMatrix(args.manifest));
  if (args.output === null) process.stdout.write(output);
  else await writeFile(args.output, output, "utf8");
}

function parseArgs(argv) {
  const args = { manifest: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest") args.manifest = argv[++index] ?? null;
    else if (argv[index] === "--output") args.output = argv[++index] ?? null;
    else if (argv[index] === "--help" || argv[index] === "-h") {
      process.stdout.write("Usage: analyze-longmemeval-stage-matrix.mjs --manifest <file> [--output <file>]\n");
      return { help: true, manifest: null, output: null };
    } else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (args.manifest === null) throw new Error("--manifest is required");
  return args;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
