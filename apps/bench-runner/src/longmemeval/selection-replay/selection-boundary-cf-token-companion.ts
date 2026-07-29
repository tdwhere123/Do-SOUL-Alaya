import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import {
  CF_TOKEN_COMPANION_SCHEMA_VERSION,
  buildCfTokenCompanionAuxiliaryEstimates,
  cfTokenCompanionEstimatorIdentity,
  type CfTokenCompanionRecordSlice,
  type LiveTokenEstimateReconstructionProof
} from "@do-soul/alaya-core";
import {
  forEachSelectionBoundaryGzipRecord
} from "./selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
} from "./selection-boundary-spool.js";

const COMPANION_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `cf token companion record UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `cf token companion record JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `cf token companion gzip exceeds the ${maxBytes} byte size limit`
});

export type CfTokenCompanionManifest = Readonly<{
  readonly schema_version: typeof CF_TOKEN_COMPANION_SCHEMA_VERSION;
  readonly kind: "cf_token_companion_v1";
  readonly cell: "A" | "B";
  readonly estimator: ReturnType<typeof cfTokenCompanionEstimatorIdentity>;
  readonly boundary_artifact_gzip_sha256: string;
  readonly live_reconstruction: LiveTokenEstimateReconstructionProof;
  readonly authoritative_record_count: number;
  readonly source_record_count: number;
  readonly auxiliary_estimate_count: number;
  readonly unique_auxiliary_content_count: number;
  readonly companion_ndjson_sha256: string;
  readonly companion_gzip_sha256: string;
}>;

export type CfTokenCompanionLoad = Readonly<{
  readonly manifest: CfTokenCompanionManifest;
  readonly recordsByKey: ReadonlyMap<string, CfTokenCompanionRecordSlice>;
}>;

export function companionRecordKey(
  questionId: string,
  invocationIndex: number
): string {
  return `${questionId}\u0000${invocationIndex}`;
}

export async function buildCfTokenCompanionArtifact(input: {
  readonly cell: "A" | "B";
  readonly boundaryArtifactPath: string;
  readonly outputDirectory: string;
  readonly maxArtifactBytes?: number;
}): Promise<CfTokenCompanionManifest> {
  const maxArtifactBytes = input.maxArtifactBytes ??
    LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES;
  const boundarySha = await sha256File(input.boundaryArtifactPath);
  const records: CfTokenCompanionRecordSlice[] = [];
  let livePairs = 0;
  let liveMismatches = 0;
  let auxiliaryEstimateCount = 0;
  const uniqueAuxiliary = new Set<string>();
  let sourceRecordCount = 0;

  await forEachSelectionBoundaryGzipRecord(
    input.boundaryArtifactPath,
    maxArtifactBytes,
    COMPANION_ERRORS,
    (record) => {
      sourceRecordCount += 1;
      if (!record.authoritative) return;
      const built = buildCfTokenCompanionAuxiliaryEstimates(record.boundary);
      livePairs += built.liveProof.pairs_checked;
      liveMismatches += built.liveProof.mismatches;
      auxiliaryEstimateCount += built.auxiliary_estimates.length;
      for (const [digest] of built.auxiliary_estimates) {
        uniqueAuxiliary.add(digest);
      }
      records.push(Object.freeze({
        question_id: record.question_id,
        invocation_index: record.invocation_index,
        authoritative: record.authoritative,
        live_estimate_count: built.live_estimate_count,
        waist_candidate_count: built.waist_candidate_count,
        auxiliary_estimates: built.auxiliary_estimates
      }));
    }
  );

  if (liveMismatches > 0) {
    throw new Error(
      `cf token companion refused for cell ${input.cell}: live reconstruction mismatches=${liveMismatches}`
    );
  }

  await mkdir(input.outputDirectory, { recursive: true });
  const ndjsonPath = join(
    input.outputDirectory,
    `companion-${input.cell.toLowerCase()}.ndjson`
  );
  const gzipPath = `${ndjsonPath}.gz`;
  const manifestPath = join(
    input.outputDirectory,
    `companion-${input.cell.toLowerCase()}.manifest.json`
  );

  const ndjson = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const ndjsonSha = createHash("sha256").update(ndjson, "utf8").digest("hex");
  await writeFile(ndjsonPath, ndjson, "utf8");
  await gzipFile(ndjsonPath, gzipPath);
  const gzipSha = await sha256File(gzipPath);
  await rm(ndjsonPath, { force: true });

  const manifest: CfTokenCompanionManifest = Object.freeze({
    schema_version: CF_TOKEN_COMPANION_SCHEMA_VERSION,
    kind: "cf_token_companion_v1",
    cell: input.cell,
    estimator: cfTokenCompanionEstimatorIdentity(),
    boundary_artifact_gzip_sha256: boundarySha,
    live_reconstruction: Object.freeze({
      pairs_checked: livePairs,
      mismatches: liveMismatches,
      status: "exact" as const
    }),
    authoritative_record_count: records.length,
    source_record_count: sourceRecordCount,
    auxiliary_estimate_count: auxiliaryEstimateCount,
    unique_auxiliary_content_count: uniqueAuxiliary.size,
    companion_ndjson_sha256: ndjsonSha,
    companion_gzip_sha256: gzipSha
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function loadCfTokenCompanionArtifact(input: {
  readonly gzipPath: string;
  readonly manifestPath: string;
}): Promise<CfTokenCompanionLoad> {
  const manifest = JSON.parse(
    await readFile(input.manifestPath, "utf8")
  ) as CfTokenCompanionManifest;
  if (manifest.kind !== "cf_token_companion_v1" ||
    manifest.schema_version !== CF_TOKEN_COMPANION_SCHEMA_VERSION) {
    throw new Error("cf token companion manifest schema mismatch");
  }
  const actualGzipSha = await sha256File(input.gzipPath);
  if (actualGzipSha !== manifest.companion_gzip_sha256) {
    throw new Error("cf token companion gzip digest mismatch");
  }

  const recordsByKey = new Map<string, CfTokenCompanionRecordSlice>();
  const hash = createHash("sha256");
  const rl = createInterface({
    input: createReadStream(input.gzipPath).pipe(createGunzip()),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (line.length === 0) continue;
    hash.update(line, "utf8");
    hash.update("\n", "utf8");
    const record = JSON.parse(line) as CfTokenCompanionRecordSlice;
    recordsByKey.set(
      companionRecordKey(record.question_id, record.invocation_index),
      Object.freeze(record)
    );
  }
  if (hash.digest("hex") !== manifest.companion_ndjson_sha256) {
    throw new Error("cf token companion ndjson digest mismatch");
  }
  if (recordsByKey.size !== manifest.authoritative_record_count) {
    throw new Error("cf token companion record count mismatch");
  }
  return Object.freeze({
    manifest,
    recordsByKey
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk: string | Buffer) => {
        hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      })
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

async function gzipFile(sourcePath: string, gzipPath: string): Promise<void> {
  const partial = `${gzipPath}.partial`;
  await mkdir(dirname(gzipPath), { recursive: true });
  try {
    await pipeline(
      createReadStream(sourcePath),
      createGzip(),
      createWriteStream(partial, { flags: "wx" })
    );
    await rename(partial, gzipPath);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
