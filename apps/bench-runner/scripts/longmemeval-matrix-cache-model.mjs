import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveMatrixExtractionModel(manifest, explicitModel) {
  const manifestModel = typeof manifest?.extraction_model === "string"
    ? manifest.extraction_model.trim()
    : "";
  if (manifestModel.length === 0) {
    throw new Error("extraction cache manifest has no extraction_model");
  }
  if (explicitModel !== undefined && explicitModel !== manifestModel) {
    throw new Error(
      `explicit matrix extraction model ${JSON.stringify(explicitModel)} ` +
      `does not match extraction cache manifest ${JSON.stringify(manifestModel)}`
    );
  }
  return manifestModel;
}

function run(argv) {
  const [manifestPath, explicitModel] = argv;
  if (manifestPath === undefined) {
    throw new Error("usage: longmemeval-matrix-cache-model.mjs <manifest.json> [explicit-model]");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  process.stdout.write(`${resolveMatrixExtractionModel(manifest, explicitModel)}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}
