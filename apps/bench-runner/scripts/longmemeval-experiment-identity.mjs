import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
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
    "evaluation_slice",
    "derived_snapshot_identity"
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
    derived_snapshot_identity: cellA.derived_snapshot_identity,
    weight_overrides: cellA.weight_overrides,
    cells: {
      A: cellA.treatment,
      B: cellB.treatment
    }
  };
}

export function bindExperimentCellRebuildIdentity(cell, rankIdentity) {
  if (cell?.treatment?.derived_evidence_projection_rebuild !== true ||
      cell.derived_snapshot_identity !== null) {
    throw new Error("experiment cell is not awaiting a derived rebuild identity");
  }
  const report = rankIdentity?.snapshot_binding
    ?.derived_evidence_projection_rebuild;
  if (!isRebuildReport(report)) {
    throw new Error("experiment rank artifact lacks a complete derived rebuild identity");
  }
  if (report.input_db_sha256 !== cell.snapshot?.db_sha256) {
    throw new Error("derived rebuild input differs from the frozen experiment snapshot");
  }
  return { ...cell, derived_snapshot_identity: report };
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
    value.treatment?.cross_encoder_enabled === false &&
    typeof value.treatment?.derived_evidence_projection_rebuild === "boolean" &&
    (value.treatment.derived_evidence_projection_rebuild
      ? isRebuildReport(value.derived_snapshot_identity) &&
        value.derived_snapshot_identity.input_db_sha256 === value.snapshot.db_sha256
      : value.derived_snapshot_identity === null);
  if (!valid) throw new Error(`experiment A/B identity has invalid cell ${cell}`);
}

function isRebuildReport(value) {
  return isRecord(value) &&
    value.schema_version === 1 &&
    value.promotable === false &&
    isSha256(value.input_db_sha256) &&
    isSha256(value.rebuilt_db_identity_sha256) &&
    isNonnegativeInteger(value.source_schema_version) &&
    isNonnegativeInteger(value.working_schema_version) &&
    [
      "eligible_owner_count",
      "rebuilt_owner_count",
      "rejected_owner_count",
      "zero_child_owner_count",
      "nonzero_child_owner_count",
      "child_count"
    ].every((field) => isNonnegativeInteger(value[field])) &&
    Array.isArray(value.projection_kind_counts) &&
    value.projection_kind_counts.every((row) =>
      isRecord(row) && typeof row.projection_kind === "string" &&
      isNonnegativeInteger(row.child_count)) &&
    isSha256(value.projection_content_sha256);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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
  if (command === "bind-rebuild" && args.length === 2) {
    const [cellPath, rankPath] = args;
    const [cell, rank] = await Promise.all([
      readFile(cellPath).then((bytes) => parseJson(bytes, cellPath)),
      readFile(rankPath).then((bytes) => parseJson(bytes, rankPath))
    ]);
    const temporaryPath = `${cellPath}.tmp-${process.pid}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(bindExperimentCellRebuildIdentity(cell, rank), null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await rename(temporaryPath, cellPath);
    return;
  }
  throw new Error(
    "usage: longmemeval-experiment-identity.mjs " +
    "snapshot <snapshot.db> <dataset.json> | " +
    "pair <A.json> <B.json> <out.json> | bind-rebuild <cell.json> <rank.json>"
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  });
}
