import { createHash } from "node:crypto";
import {
  CANONICAL_CAPTURE_ALGORITHM_ID,
  CANONICAL_CAPTURE_ALGORITHM_VERSION,
  CANONICAL_CAPTURE_IDENTITY_BLOB,
  CANONICAL_CAPTURE_IDENTITY_BLOB_ID,
  CANONICAL_CAPTURE_IDENTITY_DIGEST
} from "@do-soul/alaya-protocol";

export const SHADOW_ALGORITHM_ID = CANONICAL_CAPTURE_ALGORITHM_ID;
export const SHADOW_ALGORITHM_VERSION = CANONICAL_CAPTURE_ALGORITHM_VERSION;
export const CAPTURE_IDENTITY_BLOB_ID = CANONICAL_CAPTURE_IDENTITY_BLOB_ID;
export const SHADOW_PSI_OPERATOR_ID = "shadow.psi.safe_dominance.v1";
export const SHADOW_FRONTIER_OPERATOR_ID = "shadow.frontiers.peel_undominated.v1";
export const SHADOW_CAPTURE_OPERATOR_ID = "shadow.select_gamma.lexicographic_set.v1";

export const CAPTURE_IDENTITY_BLOB = CANONICAL_CAPTURE_IDENTITY_BLOB;
export const CAPTURE_IDENTITY_DIGEST = CANONICAL_CAPTURE_IDENTITY_DIGEST;

export function hashCaptureIdentityBlob(blob: string = CAPTURE_IDENTITY_BLOB): string {
  return createHash("sha256").update(blob, "utf8").digest("hex");
}
