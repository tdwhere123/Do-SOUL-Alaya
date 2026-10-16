import { createHash } from "node:crypto";
import type { FieldContractSha256 } from "@do-soul/alaya-protocol";

export const fieldContractSha256: FieldContractSha256 = (preimage) =>
  createHash("sha256").update(preimage, "utf8").digest("hex");

/** Chunks must end at Unicode scalar boundaries, as canonicalJsonChunks does. */
export function fieldContractSha256Chunks(chunks: Iterable<string>,
  meter?: { charge(work: number, bytes: number, phase?: string): void }): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    meter?.charge(1, Buffer.byteLength(chunk, "utf8"), "canonical identity hash handoff");
    hash.update(chunk, "utf8");
  }
  return hash.digest("hex");
}
