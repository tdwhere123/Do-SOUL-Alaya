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
  const decompressedLimit = Math.min(maxArtifactBytes * 8, 1024 * 1024 * 1024);
  const recordLimit = Math.min(maxArtifactBytes, 16 * 1024 * 1024);
  let recordCount = 0;
  let callbackError: unknown;
  let limitError: Error | undefined;
  let recordLimitError: Error | undefined;
  try {
    await pipeline(
      createReadStream(artifactPath),
      createCompressedSizeLimit(maxArtifactBytes, errors.gzipExceeded),
      createGunzip(),
      createByteLimit(
        decompressedLimit,
        `selection boundary artifact exceeds ${decompressedLimit} decompressed bytes`,
        (error) => { limitError = error; }
      ),
      async (source) => {
        recordCount = await consumeSelectionBoundaryRecords({
          source, recordLimit, errors, onRecord,
          onRecordLimitError: (error) => { recordLimitError = error; },
          onCallbackError: (error) => { callbackError = error; }
        });
      }
    );
  } catch (error) {
    if (callbackError !== undefined) throw callbackError;
    if (recordLimitError !== undefined) throw recordLimitError;
    if (limitError !== undefined) throw limitError;
    throw error;
  }
  return { recordCount };
}

async function consumeSelectionBoundaryRecords(input: Readonly<{
  source: AsyncIterable<Buffer | string>;
  recordLimit: number;
  errors: SelectionBoundaryArtifactErrors;
  onRecord: (
    record: SelectionBoundaryArtifactRecord,
    recordIndex: number
  ) => void | Promise<void>;
  onRecordLimitError: (error: Error) => void;
  onCallbackError: (error: unknown) => void;
}>): Promise<number> {
  let recordCount = 0;
  for await (const encoded of readLfDelimitedRecords(
    input.source, input.recordLimit, input.onRecordLimitError
  )) {
    if (encoded.byteLength === 0) continue;
    const record = parseSelectionBoundaryRecord(
      decodeSelectionBoundaryRecord(encoded, recordCount, input.errors.utf8Invalid),
      recordCount,
      input.errors.jsonInvalid
    );
    try {
      await input.onRecord(record, recordCount);
    } catch (error) {
      input.onCallbackError(error);
      throw error;
    }
    recordCount += 1;
  }
  return recordCount;
}

async function* readLfDelimitedRecords(
  stream: AsyncIterable<Buffer | string>,
  maxRecordBytes: number,
  onExceeded: (error: Error) => void
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    let newline = raw.indexOf(0x0a, start);
    while (newline >= 0) {
      const tail = raw.subarray(start, newline);
      assertRecordSize(pendingBytes + tail.byteLength, maxRecordBytes, onExceeded);
      yield completeRecord(pending, tail);
      pending = [];
      pendingBytes = 0;
      start = newline + 1;
      newline = raw.indexOf(0x0a, start);
    }
    if (start < raw.byteLength) {
      const tail = raw.subarray(start);
      pendingBytes += tail.byteLength;
      assertRecordSize(pendingBytes, maxRecordBytes, onExceeded);
      pending.push(tail);
    }
  }
  if (pending.length > 0) yield Buffer.concat(pending);
}

function assertRecordSize(
  bytes: number,
  maxBytes: number,
  onExceeded: (error: Error) => void
): void {
  if (bytes > maxBytes) {
    const error = new Error(
      `selection boundary record exceeds ${maxBytes} decompressed bytes`
    );
    onExceeded(error);
    throw error;
  }
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
  return createByteLimit(maxBytes, gzipExceeded(maxBytes));
}

function createByteLimit(
  maxBytes: number,
  message: string,
  onExceeded: (error: Error) => void = () => undefined
): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        const error = new Error(message);
        onExceeded(error);
        callback(error);
        return;
      }
      callback(null, chunk);
    }
  });
}
