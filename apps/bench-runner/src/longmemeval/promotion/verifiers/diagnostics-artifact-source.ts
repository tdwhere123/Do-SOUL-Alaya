import type { FileHandle } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import {
  createArtifactReadStream,
  decodeArtifactUtf8
} from "../../diagnostics/artifacts/artifact-utf8.js";

export interface RecallEvalDiagnosticsSource {
  readonly chunks: AsyncIterable<string>;
  readonly destroy: () => void;
}

export function createRecallEvalDiagnosticsSource(input: {
  readonly handle: FileHandle;
  readonly gzip: boolean;
  readonly maxDecodedBytes: number;
  readonly observeArtifactChunk: (chunk: Uint8Array) => void;
}): RecallEvalDiagnosticsSource {
  const source = createArtifactReadStream(input.handle);
  if (!input.gzip) {
    return {
      chunks: decodeArtifactUtf8(
        limitDecodedBytes(source, input.maxDecodedBytes),
        input.observeArtifactChunk
      ),
      destroy: () => source.destroy()
    };
  }

  const gunzip = createGunzip();
  source.on("data", (chunk: string | Buffer) => {
    input.observeArtifactChunk(
      typeof chunk === "string" ? Buffer.from(chunk) : chunk
    );
  });
  source.once("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  return {
    chunks: decodeArtifactUtf8(
      limitDecodedBytes(gunzip, input.maxDecodedBytes)
    ),
    destroy: () => {
      source.destroy();
      gunzip.destroy();
    }
  };
}

async function* limitDecodedBytes(
  chunks: AsyncIterable<unknown>,
  maxBytes: number
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of chunks) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new Error(`recall-eval diagnostics exceed ${maxBytes} decoded bytes`);
    }
    yield bytes;
  }
}
