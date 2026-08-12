import {
  decodeCanonicalUtf8Artifact,
  readBoundedStableRegularFile
} from "../../cache-audit/bounded-artifact-reader.js";

const MAX_EXTRACTION_CACHE_MANIFEST_BYTES = 32 * 1024 * 1024;

export function readExtractionCacheManifestBytes(filePath: string): {
  readonly bytes: Buffer;
  readonly text: string;
} {
  const bytes = readManifestBytes(filePath);
  return { bytes, text: decodeManifestBytes(bytes, filePath) };
}

function readManifestBytes(filePath: string): Buffer {
  try {
    return readBoundedStableRegularFile({
      path: filePath,
      maxBytes: MAX_EXTRACTION_CACHE_MANIFEST_BYTES,
      label: "extraction cache manifest"
    }).bytes;
  } catch (cause) {
    throw new Error(
      `extraction cache manifest unreadable at ${filePath}: ${describeCause(cause)}`
    );
  }
}

function decodeManifestBytes(raw: Uint8Array, filePath: string): string {
  try {
    return decodeCanonicalUtf8Artifact(raw, "extraction cache manifest");
  } catch (cause) {
    throw new Error(
      `extraction cache manifest is not valid UTF-8 at ${filePath}: ${describeCause(cause)}`
    );
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
