import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export async function readExperimentSnapshotIdentity(snapshotPath, datasetPath) {
  const [
    dbSha256,
    manifestSha256,
    sidecarSha256,
    authoritySha256,
    datasetSha256
  ] = await Promise.all([
    sha256File(snapshotPath),
    sha256File(`${snapshotPath}.manifest.json`),
    sha256File(`${snapshotPath}.sidecar.json`),
    sha256File(`${snapshotPath}.extraction-authority.json`),
    sha256File(datasetPath)
  ]);
  return {
    snapshot: {
      db_sha256: dbSha256,
      manifest_sha256: manifestSha256,
      sidecar_sha256: sidecarSha256,
      extraction_authority_sha256: authoritySha256
    },
    dataset: { sha256: datasetSha256 }
  };
}

export function buildExperimentPairIdentity(cellA, cellB) {
  assertCell(cellA, "A", "disabled");
  assertCell(cellB, "B", "env");
  const common = [
    "run_root",
    "snapshot",
    "dataset",
    "runner",
    "weight_overrides",
    "evaluation_slice"
  ];
  if (common.some((field) => !isDeepStrictEqual(cellA[field], cellB[field])) ||
      !isDeepStrictEqual(
        treatmentWithoutEmbedding(cellA.treatment),
        treatmentWithoutEmbedding(cellB.treatment)
      )) {
    throw new Error("experiment A/B identity differs outside embedding treatment");
  }
  return {
    schema_version: 1,
    kind: "longmemeval_experiment_pair_identity",
    snapshot: cellA.snapshot,
    dataset: cellA.dataset,
    runner: cellA.runner,
    evaluation_slice: cellA.evaluation_slice,
    weight_overrides: cellA.weight_overrides,
    cells: {
      A: cellA.treatment,
      B: cellB.treatment
    }
  };
}

function assertCell(value, cell, embeddingMode) {
  const valid = value?.schema_version === 2 &&
    value.kind === "longmemeval_matrix_cell_runner_identity" &&
    value.mode === "experiment" &&
    value.cell === cell &&
    typeof value.run_root === "string" &&
    isRecord(value.snapshot) &&
    isRecord(value.dataset) &&
    isRecord(value.runner) &&
    isEvaluationSlice(value.evaluation_slice) &&
    typeof value.treatment?.extraction_model === "string" &&
    value.treatment?.embedding_mode === embeddingMode &&
    value.treatment?.cross_encoder_enabled === false;
  if (!valid) throw new Error(`experiment A/B identity has invalid cell ${cell}`);
}

function isEvaluationSlice(value) {
  return isRecord(value) &&
    Number.isInteger(value.offset) &&
    value.offset >= 0 &&
    (value.limit === null || (Number.isInteger(value.limit) && value.limit > 0));
}

function treatmentWithoutEmbedding(treatment) {
  const { embedding_mode: _embeddingMode, ...common } = treatment;
  return common;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(bytes, filename) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`invalid experiment JSON ${filename}`, { cause });
  }
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function run(argv) {
  const [command, ...args] = argv;
  if (command === "snapshot" && args.length === 2) {
    process.stdout.write(`${JSON.stringify(
      await readExperimentSnapshotIdentity(args[0], args[1])
    )}\n`);
    return;
  }
  if (command === "pair" && args.length === 3) {
    const [aPath, bPath, outputPath] = args;
    const [cellA, cellB] = await Promise.all([
      readFile(aPath).then((bytes) => parseJson(bytes, aPath)),
      readFile(bPath).then((bytes) => parseJson(bytes, bPath))
    ]);
    await writeFile(
      outputPath,
      `${JSON.stringify(buildExperimentPairIdentity(cellA, cellB), null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    return;
  }
  throw new Error(
    "usage: longmemeval-experiment-identity.mjs " +
    "snapshot <snapshot.db> <dataset.json> | pair <A.json> <B.json> <out.json>"
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  });
}
