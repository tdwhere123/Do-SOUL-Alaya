import { readFileSync } from "node:fs";

export function readExtractionCacheManifestBytes(filePath: string): {
  readonly bytes: Buffer;
  readonly text: string;
} {
  const bytes = readManifestBytes(filePath);
  return { bytes, text: decodeManifestBytes(bytes, filePath) };
}

function readManifestBytes(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (cause) {
    throw new Error(
      `extraction cache manifest unreadable at ${filePath}: ${describeCause(cause)}`
    );
  }
}

function decodeManifestBytes(raw: Uint8Array, filePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch (cause) {
    throw new Error(
      `extraction cache manifest is not valid UTF-8 at ${filePath}: ${describeCause(cause)}`
    );
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
