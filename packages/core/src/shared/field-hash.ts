import { createHash } from "node:crypto";
import type { FieldContractSha256 } from "@do-soul/alaya-protocol";

export const fieldContractSha256: FieldContractSha256 = (preimage) =>
  createHash("sha256").update(preimage, "utf8").digest("hex");
