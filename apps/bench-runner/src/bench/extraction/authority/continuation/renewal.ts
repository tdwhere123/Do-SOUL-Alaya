import type {
  ExtractionTransportAuthorityTerms,
  SameRootExtractionContinuation
} from "./contract.js";
import { sameRootContinuationMode } from "./contract.js";

interface TransportAuthorityReceipt {
  readonly action: "probe" | "fill";
  readonly target_selection_digest?: string;
  readonly limits: Readonly<{
    starting_missing: number;
    maximum_attempts: number;
    successful_shard_ceiling: number;
    max_concurrency: number;
    max_output_tokens: number;
    output_token_field: "max_tokens" | "max_completion_tokens";
    disk_floor_bytes: number;
    no_progress_timeout_ms: number;
  }>;
  readonly price: Readonly<{
    input_usd_per_million: number;
    output_usd_per_million: number;
    maximum_input_tokens_per_attempt: number;
  }>;
  readonly continuation?: SameRootExtractionContinuation;
  readonly direct_spend?: unknown;
  readonly repair_scope?: unknown;
  readonly catalog_refill?: unknown;
}

export function captureExtractionTransportAuthority(
  receipt: TransportAuthorityReceipt
): ExtractionTransportAuthorityTerms {
  if (receipt.action !== "fill" || receipt.target_selection_digest === undefined) {
    throw new Error("output token cap renewal requires a normal fill authority");
  }
  return Object.freeze({
    action: receipt.action,
    target_selection_digest: receipt.target_selection_digest,
    ...receipt.limits,
    input_usd_per_million: receipt.price.input_usd_per_million,
    output_usd_per_million: receipt.price.output_usd_per_million,
    maximum_input_tokens_per_attempt: receipt.price.maximum_input_tokens_per_attempt
  });
}

export function assertExtractionAuthorityRenewal(
  receipt: TransportAuthorityReceipt,
  predecessor?: TransportAuthorityReceipt
): void {
  const continuation = receipt.continuation;
  if (continuation === undefined) return;
  const mode = sameRootContinuationMode(continuation);
  if (mode !== "output_token_cap_renewal" && mode !== "transport_successor") return;
  const prior = continuation.predecessor_transport_authority!;
  if (predecessor !== undefined &&
      JSON.stringify(prior) !== JSON.stringify(captureExtractionTransportAuthority(predecessor))) {
    throw new Error("output token cap renewal predecessor authority drifted");
  }
  if (mode === "transport_successor") {
    assertTransportSuccessorTermsUnchanged(receipt, prior);
  } else {
    assertOnlyOutputTokenCapIncreased(receipt, prior);
  }
}

function assertTransportSuccessorTermsUnchanged(
  receipt: TransportAuthorityReceipt,
  prior: ExtractionTransportAuthorityTerms
): void {
  if (JSON.stringify(captureExtractionTransportAuthority(receipt)) !== JSON.stringify(prior) ||
      receipt.direct_spend !== undefined || receipt.repair_scope !== undefined ||
      receipt.catalog_refill !== undefined) {
    throw new Error("transport successor changed another authority term");
  }
}

function assertOnlyOutputTokenCapIncreased(
  receipt: TransportAuthorityReceipt,
  prior: ExtractionTransportAuthorityTerms
): void {
  const current = captureExtractionTransportAuthority(receipt);
  if (current.output_token_field !== prior.output_token_field ||
      current.max_output_tokens <= prior.max_output_tokens) {
    throw new Error("output token cap renewal must strictly increase the existing field");
  }
  const unchanged = {
    ...current,
    max_output_tokens: prior.max_output_tokens,
    max_concurrency: prior.max_concurrency
  };
  if (JSON.stringify(unchanged) !== JSON.stringify(prior) ||
      current.max_concurrency > prior.max_concurrency ||
      receipt.direct_spend !== undefined || receipt.repair_scope !== undefined ||
      receipt.catalog_refill !== undefined) {
    throw new Error("output token cap renewal changed another authority term");
  }
}
