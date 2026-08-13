import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { TextDecoder } from "node:util";
import { createGunzip } from "node:zlib";
import type { FineAssessmentSelectionBoundaryCase } from "@do-soul/alaya-core";

export type SelectionBoundaryArtifactRecord = Readonly<{
  readonly question_id: string;
  readonly invocation_index: number;
  readonly authoritative: boolean;
  readonly boundary: FineAssessmentSelectionBoundaryCase;
}>;

export type SelectionBoundaryArtifactErrors = Readonly<{
  readonly utf8Invalid: (context: string) => string;
  readonly jsonInvalid: (context: string) => string;
  readonly gzipExceeded: (maxBytes: number) => string;
}>;

export async function forEachSelectionBoundaryGzipRecord(
  artifactPath: string,
  maxArtifactBytes: number,
  errors: SelectionBoundaryArtifactErrors,
  onRecord: (
    record: SelectionBoundaryArtifactRecord,
    recordIndex: number
  ) => void | Promise<void>
): Promise<{ readonly recordCount: number }> {
  let recordCount = 0;
  let callbackError: unknown;
  try {
    await pipeline(
      createReadStream(artifactPath),
      createCompressedSizeLimit(maxArtifactBytes, errors.gzipExceeded),
      createGunzip(),
      async (source) => {
        for await (const encoded of readLfDelimitedRecords(source)) {
          if (encoded.byteLength === 0) continue;
          const record = parseSelectionBoundaryRecord(
            decodeSelectionBoundaryRecord(
              encoded,
              recordCount,
              errors.utf8Invalid
            ),
            recordCount,
            errors.jsonInvalid
          );
          try {
            await onRecord(record, recordCount);
          } catch (error) {
            callbackError = error;
            throw error;
          }
          recordCount += 1;
        }
      }
    );
  } catch (error) {
    if (callbackError !== undefined) throw callbackError;
    throw error;
  }
  return { recordCount };
}

async function* readLfDelimitedRecords(
  stream: AsyncIterable<Buffer | string>
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  for await (const chunk of stream) {
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    let newline = raw.indexOf(0x0a, start);
    while (newline >= 0) {
      yield completeRecord(pending, raw.subarray(start, newline));
      pending = [];
      start = newline + 1;
      newline = raw.indexOf(0x0a, start);
    }
    if (start < raw.byteLength) pending.push(raw.subarray(start));
  }
  if (pending.length > 0) yield Buffer.concat(pending);
}

function completeRecord(pending: readonly Buffer[], tail: Buffer): Buffer {
  return pending.length === 0
    ? tail
    : Buffer.concat([...pending, tail]);
}

function decodeSelectionBoundaryRecord(
  encoded: Buffer,
  recordIndex: number,
  utf8Invalid: (context: string) => string
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  } catch {
    const context = [
      `record_index=${recordIndex}`,
      `utf8_bytes=${encoded.byteLength}`,
      `sha256=${createHash("sha256").update(encoded).digest("hex")}`
    ].join(", ");
    throw new Error(utf8Invalid(context));
  }
}

function parseSelectionBoundaryRecord(
  line: string,
  recordIndex: number,
  jsonInvalid: (context: string) => string
): SelectionBoundaryArtifactRecord {
  try {
    return JSON.parse(line) as SelectionBoundaryArtifactRecord;
  } catch {
    const sha256 = createHash("sha256").update(line, "utf8").digest("hex");
    const context = [
      `record_index=${recordIndex}`,
      `chars=${line.length}`,
      `utf8_bytes=${Buffer.byteLength(line, "utf8")}`,
      `sha256=${sha256}`
    ].join(", ");
    throw new Error(jsonInvalid(context));
  }
}

/** Shared read/write gzip byte-cap; message text stays caller-owned. */
export function createCompressedSizeLimit(
  maxBytes: number,
  gzipExceeded: (maxBytes: number) => string
): Transform {
  let compressedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > maxBytes) {
        callback(new Error(gzipExceeded(maxBytes)));
        return;
      }
      callback(null, chunk);
    }
  });
}
