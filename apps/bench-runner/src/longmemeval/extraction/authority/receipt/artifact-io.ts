import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from
  "../../fill/manifest/durable-exclusive-publication.js";

export const MAX_EXTRACTION_AUTHORITY_RECEIPT_BYTES = 16 * 1024 * 1024;

export function writeExtractionAuthorityReceiptArtifact(
  outputPath: string,
  receipt: object
): void {
  const bytes = serializeReceipt(receipt);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, outputPath);
}

export function writeExtractionAuthorityReceiptArtifactExclusive(
  outputPath: string,
  receipt: object,
  ownerIdentity: string
): void {
  const bytes = serializeReceipt(receipt);
  mkdirSync(dirname(outputPath), { recursive: true });
  publishBytesExclusiveDurable({
    destination: outputPath,
    bytes,
    ownerIdentity,
    temporaryDirectory: dirname(outputPath),
    allowExistingExact: true
  });
}

export function readExtractionAuthorityReceiptArtifact(outputPath: string): unknown {
  try {
    return JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: outputPath,
      maxBytes: MAX_EXTRACTION_AUTHORITY_RECEIPT_BYTES,
      label: "extraction authority receipt"
    })) as unknown;
  } catch (cause) {
    throw new Error(`extraction authority receipt is unreadable: ${outputPath}`, { cause });
  }
}

function serializeReceipt(receipt: object): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_EXTRACTION_AUTHORITY_RECEIPT_BYTES) {
    throw new Error("extraction authority receipt exceeds its size limit");
  }
  return bytes;
}
