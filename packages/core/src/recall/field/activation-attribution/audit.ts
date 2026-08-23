import { digestRecallFieldIdentity } from "../field-identity.js";
import { compileRecallQueryProbes } from "../../query/recall-query-probes.js";
import { classifyActivationAttribution } from "./classify.js";
import {
  inspectCharNgramConsumer,
  inspectSourceProximityConsumer
} from "./consumers.js";
import {
  ACTIVATION_ATTRIBUTION_OPERATOR_ID,
  type ActivationAttributionAuditReceipt,
  type ActivationAttributionAuditRow
} from "./types.js";

export {
  ACTIVATION_ATTRIBUTION_CHANNELS,
  ACTIVATION_ATTRIBUTION_FUEL_CHANNELS,
  ACTIVATION_ATTRIBUTION_OPERATOR_ID,
  ACTIVATION_ATTRIBUTION_STATUSES
} from "./types.js";
export type {
  ActivationAttributionAuditReceipt,
  ActivationAttributionAuditRow,
  ActivationAttributionChannel,
  ActivationAttributionChannelReceipt,
  ActivationAttributionFloodObservation,
  ActivationAttributionQueryShape,
  ActivationAttributionReason,
  ActivationAttributionStatus,
  CharNgramConsumerFact,
  SourceProximityConsumerFact
} from "./types.js";
export {
  inspectCharNgramConsumer,
  inspectSourceProximityConsumer,
  QUERY_PROBE_RETRIEVAL_FIELDS
} from "./consumers.js";

export function auditActivationAttribution(
  row: ActivationAttributionAuditRow
): ActivationAttributionAuditReceipt {
  const probes = compileRecallQueryProbes(row.query_text);
  const classified = classifyActivationAttribution(row, probes);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: ACTIVATION_ATTRIBUTION_OPERATOR_ID,
    query_id: row.query_id,
    query_shape: row.query_shape,
    query_text: row.query_text,
    intent: classified.intent,
    fuel_verified: classified.fuel_verified,
    channels: classified.channels,
    char_ngram_consumer: inspectCharNgramConsumer(probes),
    source_proximity_consumer: inspectSourceProximityConsumer()
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyActivationAttributionAudit(
  receipt: Readonly<ActivationAttributionAuditReceipt>,
  row: ActivationAttributionAuditRow
): void {
  const derived = auditActivationAttribution(row);
  if (derived.receipt_digest !== receipt.receipt_digest) {
    throw new Error("activation attribution audit digest mismatch");
  }
}
