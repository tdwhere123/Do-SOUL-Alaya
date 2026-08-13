import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  buildFineAssessmentOrderLedger,
  reconstructFineAssessmentComposition
} from "@do-soul/alaya-core";
import { publishBytesExclusiveDurable } from
  "../extraction/fill/manifest/durable-exclusive-publication.js";
import { measureGitState } from
  "../provenance/contract/frozen-code-contract.js";
import { sha256File } from "../snapshot/integrity.js";
import {
  forEachSelectionBoundaryGzipRecord,
  type SelectionBoundaryArtifactRecord
} from "./selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES,
  verifyLongMemEvalSelectionBoundaryArtifact
} from
  "./selection-boundary-spool.js";
import { withSelectionBoundaryRecordIdentity } from
  "./selection-boundary-record-identity.js";

const ARTIFACT_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `selection order ledger source UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `selection order ledger source JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `selection order ledger source exceeds ${maxBytes} compressed bytes`
});

export type SelectionOrderLedgerArtifactIdentity = Readonly<{
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly source_sha256: string;
  readonly source_commit: string;
  readonly question_count: number;
  readonly candidate_count: number;
  readonly coarse_unavailable_questions: number;
}>;

export async function materializeSelectionOrderLedgerArtifact(input: {
  readonly sourcePath: string;
  readonly expectedSourceSha256: string;
  readonly outputPath: string;
  readonly checkoutRoot: string;
}): Promise<SelectionOrderLedgerArtifactIdentity> {
  assertSha256(input.expectedSourceSha256);
  const [sourceSha256, git] = await Promise.all([
    sha256File(input.sourcePath),
    measureGitState(input.checkoutRoot)
  ]);
  if (sourceSha256 !== input.expectedSourceSha256) {
    throw new Error("selection order ledger source SHA-256 mismatch");
  }
  await verifyLongMemEvalSelectionBoundaryArtifact(input.sourcePath);
  const collected = await collectLedgerRows(
    input.sourcePath,
    sourceSha256,
    git.commitSha
  );
  if (await sha256File(input.sourcePath) !== sourceSha256) {
    throw new Error("selection order ledger source changed while reading");
  }
  return publishLedgerArtifact(
    input.outputPath,
    sourceSha256,
    git.commitSha,
    collected
  );
}

async function collectLedgerRows(
  sourcePath: string,
  sourceSha256: string,
  sourceCommit: string
) {
  const rows = [JSON.stringify({
    record_type: "manifest",
    schema_version: 1,
    source_artifact_sha256: sourceSha256,
    source_commit: sourceCommit,
    authoritative_only: true
  })];
  let questionCount = 0;
  let candidateCount = 0;
  await forEachSelectionBoundaryGzipRecord(
    sourcePath,
    LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES,
    ARTIFACT_ERRORS,
    (record, recordIndex) => {
      if (!record.authoritative) return;
      const ledger = verifyRecordLedger(record, recordIndex);
      questionCount += 1;
      candidateCount += ledger.candidate_count;
      rows.push(JSON.stringify({
        record_type: "question",
        question_id: record.question_id,
        invocation_index: record.invocation_index,
        ledger
      }));
    }
  );
  rows.push(JSON.stringify({
    record_type: "summary",
    question_count: questionCount,
    candidate_count: candidateCount,
    coarse_unavailable_questions: 0
  }));
  return Object.freeze({
    rows: Object.freeze(rows),
    questionCount,
    candidateCount
  });
}

/** The first mismatch must stay attributable to one frozen source record. */
function verifyRecordLedger(
  record: SelectionBoundaryArtifactRecord,
  recordIndex: number
): ReturnType<typeof buildFineAssessmentOrderLedger> {
  return withSelectionBoundaryRecordIdentity(
    "selection order ledger record verification failed",
    record,
    recordIndex,
    () => {
      const reconstruction = reconstructFineAssessmentComposition(record.boundary);
      const ledger = buildFineAssessmentOrderLedger(
        reconstruction.result.orderSequence,
        reconstruction.result.candidates.length
      );
      if (ledger.coarse_identity === "unavailable") {
        throw new Error(
          "selection order ledger coarse identity is unavailable"
        );
      }
      return ledger;
    }
  );
}

async function publishLedgerArtifact(
  requestedOutputPath: string,
  sourceSha256: string,
  sourceCommit: string,
  collected: Awaited<ReturnType<typeof collectLedgerRows>>
): Promise<SelectionOrderLedgerArtifactIdentity> {
  const bytes = gzipSync(`${collected.rows.join("\n")}\n`, { level: 9 });
  const outputPath = await canonicalOutputPath(requestedOutputPath);
  const ownerIdentity = createHash("sha256").update(sourceSha256)
    .update("\0").update(sourceCommit).digest("hex");
  publishBytesExclusiveDurable({
    destination: outputPath,
    bytes,
    ownerIdentity,
    temporaryDirectory: dirname(outputPath)
  });
  return Object.freeze({
    path: outputPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    source_sha256: sourceSha256,
    source_commit: sourceCommit,
    question_count: collected.questionCount,
    candidate_count: collected.candidateCount,
    coarse_unavailable_questions: 0
  });
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("selection order ledger source SHA-256 is invalid");
  }
}

async function canonicalOutputPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const directory = await realpath(dirname(absolute));
  return resolve(directory, basename(absolute));
}
