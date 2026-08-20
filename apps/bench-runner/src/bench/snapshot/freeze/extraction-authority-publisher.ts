import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readRegularFileNoFollow } from "../bound-file.js";
import { MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES } from
  "../extraction-authority.js";

export function persistSnapshotExtractionAuthority(
  filePath: string,
  expectedBytes: Buffer
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(filePath, expectedBytes, { flag: "wx", mode: 0o400 });
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const persistedBytes = readRegularFileNoFollow(
    filePath,
    MAX_SNAPSHOT_EXTRACTION_AUTHORITY_BYTES
  );
  if (!persistedBytes.equals(expectedBytes)) {
    throw new Error("existing snapshot extraction authority conflicts with captured authority");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "EEXIST";
}
