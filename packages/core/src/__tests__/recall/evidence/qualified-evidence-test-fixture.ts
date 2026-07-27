import type { EvidenceCapsule } from "@do-soul/alaya-protocol";
import type {
  RecallQualifiedEvidence
} from "../../../recall/runtime/recall-service-ports.js";

export function qualifyEvidence(
  capsule: Readonly<EvidenceCapsule>,
  verifiedUserProjection = false
): Readonly<RecallQualifiedEvidence> {
  return Object.freeze({
    capsule,
    verified_user_projection: verifiedUserProjection
  });
}
