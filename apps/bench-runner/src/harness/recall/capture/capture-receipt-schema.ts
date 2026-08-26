import { createHash } from "node:crypto";
import {
  CanonicalSelectionReceiptSchema as ProtocolReceiptSchema,
  verifyCanonicalSelectionReceipt
} from "@do-soul/alaya-protocol";

export type { CanonicalSelectionReceipt } from "@do-soul/alaya-protocol";

export const CanonicalSelectionReceiptSchema = ProtocolReceiptSchema.superRefine(
  (receipt, context) => {
    try {
      verifyCanonicalSelectionReceipt(receipt, sha256);
    } catch {
      context.addIssue({ code: "custom", message: "canonical selection receipt digest mismatch" });
    }
  }
);

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
