import { hasHoleImpact, isCompletenessScope, type DeliveryAllowedClaimV1,
  type DeliveryConsumerActionV1, type DeliveryConsumerVerdictV1,
  type DeliveryPackV1 } from "./contract.js";
import { parseCertifiedDeliveryPack, parseDeliveryPack } from "./pack.js";

const ALWAYS_REJECTED = new Set<DeliveryConsumerActionV1>([
  "infer_completeness_from_packet_size",
  "hidden_filter",
  "hidden_reorder",
  "hidden_membership_cut",
  "mark_used"
]);

const CLAIM_BY_ACTION: Readonly<Partial<Record<DeliveryConsumerActionV1, DeliveryAllowedClaimV1>>> =
  Object.freeze({
    claim_scalar: "scalar",
    claim_scoped_extremum: "scoped_extremum",
    claim_scoped_all_observable: "scoped_all_observable"
  });

export function validateConsumerAction(
  pack: DeliveryPackV1,
  action: DeliveryConsumerActionV1
): DeliveryConsumerVerdictV1 {
  let captured: DeliveryPackV1;
  try {
    captured = parseDeliveryPack(pack);
  } catch (error) {
    return rejected(messageOf(error));
  }
  if (ALWAYS_REJECTED.has(action)) {
    return rejected(rejectReason(action));
  }
  if (action === "parse_as_certified") {
    try {
      parseCertifiedDeliveryPack(captured);
      return accepted();
    } catch (error) {
      return rejected(messageOf(error));
    }
  }
  const claim = CLAIM_BY_ACTION[action];
  if (claim === undefined) return rejected("consumer action is unsupported");
  if (!captured.allowed_claims.includes(claim)) {
    return rejected(`pack does not allow ${claim}`);
  }
  if (action === "claim_scoped_all_observable") {
    if (!isCompletenessScope(captured.completeness_scope)) {
      return rejected("all_observable claim requires completeness scope");
    }
    if (hasHoleImpact(captured.holes, "blocks_completeness_claim")) {
      return rejected("completeness hole blocks all_observable");
    }
  }
  if (captured.mode !== "certified") {
    return rejected("non-certified pack cannot satisfy a certified claim");
  }
  return accepted();
}

function accepted(): DeliveryConsumerVerdictV1 {
  return Object.freeze({ status: "accepted" as const });
}

function rejected(reason: string): DeliveryConsumerVerdictV1 {
  return Object.freeze({ status: "rejected" as const, reason });
}

function rejectReason(action: DeliveryConsumerActionV1): string {
  if (action === "infer_completeness_from_packet_size") {
    return "packet size cannot satisfy completeness, scalar, or extremum claims";
  }
  if (action === "mark_used") {
    return "delivered is not used";
  }
  return "hidden filter, reorder, or membership cut after pack is rejected";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "delivery pack validation failed";
}
