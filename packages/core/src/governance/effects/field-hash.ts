import { createHash } from "node:crypto";
import type { FieldContractSha256 } from "@do-soul/alaya-protocol";

export function nodeFieldSha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

export const defaultFieldSha256: FieldContractSha256 = nodeFieldSha256;
