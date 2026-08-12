import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readBoundedCanonicalUtf8Artifact } from
  "../../cache-audit/bounded-artifact-reader.js";
import { publishBytesExclusiveDurable } from
  "../../fill/manifest/durable-exclusive-publication.js";

const MAX_EXTRACTION_AUTHORITY_RECEIPT_BYTES = 64 * 1024;

export function writeExtractionAuthorityReceiptArtifact(
  outputPath: string,
  receipt: object
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  renameSync(temporary, outputPath);
}

export function writeExtractionAuthorityReceiptArtifactExclusive(
  outputPath: string,
  receipt: object,
  ownerIdentity: string
): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  publishBytesExclusiveDurable({
    destination: outputPath,
    bytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
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
