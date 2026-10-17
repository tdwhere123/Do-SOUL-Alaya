import { createHash } from "node:crypto";
import type { FieldContractSha256 } from "@do-soul/alaya-protocol";

export const fieldContractSha256: FieldContractSha256 = (preimage) =>
  createHash("sha256").update(preimage, "utf8").digest("hex");

type Meter = { charge(work: number, bytes: number, phase?: string): void };

/** Chunks must end at Unicode scalar boundaries, as canonicalJsonChunks does. */
export function fieldContractSha256Chunks(chunks: Iterable<string>,
  meter?: Meter): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    chargeHashHandoff(Buffer.byteLength(chunk, "utf8"), meter);
    hash.update(chunk, "utf8");
  }
  return hash.digest("hex");
}

/** Price future native handoffs from canonical chunk sizes; no hash or UTF-8
 * buffer is created. The planner pays only its numeric chunk-consumption work. */
export function quoteFieldContractSha256Chunks(chunkBytes: Iterable<number>, execution: Meter, planner?: Meter): void {
  for (const bytes of chunkBytes) {
    planner?.charge(1, 0, "canonical identity hash handoff quotation");
    chargeHashHandoff(bytes, execution);
  }
}

function chargeHashHandoff(bytes: number, meter?: Meter): void {
  meter?.charge(1, bytes, "canonical identity hash handoff");
}
