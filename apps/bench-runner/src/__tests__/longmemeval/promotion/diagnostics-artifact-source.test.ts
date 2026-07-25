import { gzipSync } from "node:zlib";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRecallEvalDiagnosticsSource } from
  "../../../longmemeval/promotion/verifiers/diagnostics-artifact-source.js";

describe("recall-eval diagnostics artifact source", () => {
  it("rejects gzip output beyond the decoded byte budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recall-eval-gzip-limit-"));
    const artifactPath = path.join(root, "diagnostics.json.gz");
    await writeFile(artifactPath, gzipSync("x".repeat(64)));
    const handle = await open(artifactPath, "r");
    let observedCompressedBytes = 0;
    try {
      const source = createRecallEvalDiagnosticsSource({
        handle,
        gzip: true,
        maxDecodedBytes: 32,
        observeArtifactChunk: (chunk) => {
          observedCompressedBytes += chunk.byteLength;
        }
      });
      await expect(consume(source.chunks)).rejects.toThrow(
        "recall-eval diagnostics exceed 32 decoded bytes"
      );
      source.destroy();
      expect(observedCompressedBytes).toBeGreaterThan(0);
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function consume(chunks: AsyncIterable<string>): Promise<void> {
  for await (const chunk of chunks) void chunk;
}
