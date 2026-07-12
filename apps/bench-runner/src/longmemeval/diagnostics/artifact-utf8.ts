import { createReadStream, type ReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type ArtifactReadSource = string | FileHandle;

export function createArtifactReadStream(source: ArtifactReadSource): ReadStream {
  return typeof source === "string"
    ? createReadStream(source)
    : source.createReadStream({ autoClose: false, start: 0 });
}

export async function* decodeArtifactUtf8(
  chunks: AsyncIterable<unknown>
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of chunks) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      const text = decoder.decode(bytes, { stream: true });
      if (text.length > 0) yield text;
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`invalid UTF-8: ${error.message}`);
    }
    throw error;
  }
}

export function artifactSourceLabel(source: ArtifactReadSource): string {
  return typeof source === "string" ? source : `<fd:${source.fd}>`;
}
