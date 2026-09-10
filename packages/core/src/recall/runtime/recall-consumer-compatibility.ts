import type { QueryView, RecallTargetKind, ResultKindView } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";

export const RECALL_CONSUMER_PROTOCOL_VERSION = 1 as const;

export const RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE =
  "recall consumer is incompatible with source_evidence results: declare protocol_version=1 and source_evidence support (supported_result_kinds or supports_source_evidence), or request result_kind_view=memory_only";

export const RECALL_PROTOCOL_VERSION_INCOMPATIBLE_MESSAGE =
  "recall consumer protocol_version is unsupported";

export const RECALL_PRODUCT_UPDATES_INCOMPATIBLE_MESSAGE =
  "recall consumer does not declare supports_product_updates";

export type RecallConsumerCapability = Readonly<{
  readonly protocol_version?: number;
  readonly supported_result_kinds?: readonly RecallTargetKind[];
  readonly supports_source_evidence?: boolean;
  readonly supports_product_updates?: boolean;
  readonly result_kind_view?: ResultKindView;
}>;

export function consumerSupportsSourceEvidence(input: RecallConsumerCapability): boolean {
  if (input.supports_source_evidence === true) return true;
  return input.supported_result_kinds?.includes("source_evidence") === true;
}

export function declaredRecallResultKinds(
  input: RecallConsumerCapability
): readonly RecallTargetKind[] | undefined {
  const kinds = new Set<RecallTargetKind>(input.supported_result_kinds ?? []);
  if (input.supports_source_evidence === true) {
    kinds.add("source_evidence");
    if (input.supported_result_kinds === undefined) kinds.add("memory_entry");
  }
  if (kinds.size === 0) return undefined;
  return Object.freeze([...kinds].sort());
}

export function recallConsumerViewIdentity(input: RecallConsumerCapability): Readonly<{
  readonly protocol_version?: number;
  readonly supported_result_kinds?: readonly RecallTargetKind[];
}> {
  const kinds = declaredRecallResultKinds(input);
  return {
    ...(input.protocol_version === undefined ? {} : { protocol_version: input.protocol_version }),
    ...(kinds === undefined ? {} : { supported_result_kinds: kinds })
  };
}

export function assertRecallConsumerCompatibility(input: RecallConsumerCapability): void {
  if (input.protocol_version !== undefined && input.protocol_version !== RECALL_CONSUMER_PROTOCOL_VERSION) {
    throw new CoreError("VALIDATION", RECALL_PROTOCOL_VERSION_INCOMPATIBLE_MESSAGE);
  }
  const view = input.result_kind_view ?? "mixed";
  if (view === "memory_only") return;
  if (input.protocol_version !== RECALL_CONSUMER_PROTOCOL_VERSION || !consumerSupportsSourceEvidence(input)) {
    throw new CoreError("VALIDATION", RECALL_SOURCE_EVIDENCE_INCOMPATIBLE_MESSAGE);
  }
}

export function assertRecallProductUpdateCompatibility(
  input: RecallConsumerCapability,
  productUpdates: readonly unknown[] | undefined
): void {
  if (productUpdates === undefined || productUpdates.length === 0) return;
  if (input.supports_product_updates === true) return;
  throw new CoreError("VALIDATION", RECALL_PRODUCT_UPDATES_INCOMPATIBLE_MESSAGE);
}

export function continuationConsumerIdentity(
  continuation: Readonly<{
    readonly protocol_version?: number;
    readonly supported_result_kinds?: readonly RecallTargetKind[];
  }>,
  view: QueryView
): Readonly<{
  readonly protocol_version?: number;
  readonly supported_result_kinds?: readonly RecallTargetKind[];
}> {
  return {
    ...(continuation.protocol_version === undefined && view.protocol_version === undefined
      ? {}
      : { protocol_version: continuation.protocol_version ?? view.protocol_version }),
    ...(continuation.supported_result_kinds === undefined && view.supported_result_kinds === undefined
      ? {}
      : { supported_result_kinds: continuation.supported_result_kinds ?? view.supported_result_kinds })
  };
}

export function capableRecallConsumerDeclaration(): Readonly<{
  readonly protocol_version: typeof RECALL_CONSUMER_PROTOCOL_VERSION;
  readonly supported_result_kinds: readonly ["memory_entry", "source_evidence"];
  readonly supports_source_evidence: true;
  readonly supports_product_updates: true;
}> {
  return {
    protocol_version: RECALL_CONSUMER_PROTOCOL_VERSION,
    supported_result_kinds: ["memory_entry", "source_evidence"],
    supports_source_evidence: true,
    supports_product_updates: true
  };
}
