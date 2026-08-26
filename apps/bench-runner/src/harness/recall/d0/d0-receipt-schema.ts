import { createHash } from "node:crypto";
import {
  CanonicalD0SelectionReceiptSchema as ProtocolReceiptSchema,
  verifyCanonicalD0SelectionReceipt
} from "@do-soul/alaya-protocol";

export type { CanonicalD0SelectionReceipt } from "@do-soul/alaya-protocol";

export const CanonicalD0SelectionReceiptSchema = ProtocolReceiptSchema.superRefine(
  (receipt, context) => {
    try {
      verifyCanonicalD0SelectionReceipt(receipt, sha256);
    } catch {
      context.addIssue({ code: "custom", message: "canonical D0 receipt digest mismatch" });
    }
  }
);

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
