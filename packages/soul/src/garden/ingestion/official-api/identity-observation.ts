import {
  IDENTITY_OBSERVATION_CONTRACT_VERSION,
  IDENTITY_OBSERVATION_MENTION_LIMIT,
  IDENTITY_OBSERVATION_PRODUCER,
  IdentityObservationSchema,
  SemanticIdentitySchema,
  SourceOccurrenceSchema,
  findSourceTextOccurrence,
  type IdentityObservation,
  type IdentityObservationMention,
  type IdentityObservationSpan
} from "@do-soul/alaya-protocol";
import {
  inspectOfficialApiSemanticFactorGraphProjection,
  type OfficialApiSemanticFactorGraphProjection
} from "./semantic-factor-projection.js";

export const OFFICIAL_API_IDENTITY_OBSERVATION_RECEIVE_CONTRACT_VERSION = 1 as const;
export const OFFICIAL_API_IDENTITY_OBSERVATION_RECEIVE_PRODUCER =
  "official-api-identity-observation-receive-v1" as const;

export type OfficialApiIdentityObservationReceiveStatus = "complete" | "partial" | "empty";

export type OfficialApiIdentityObservationReceiveRejectionReason =
  | "identity_observation_invalid"
  | "mention_not_source_grounded"
  | "topology_rejected";

export interface OfficialApiIdentityObservationReceiveRejection {
  readonly reason: OfficialApiIdentityObservationReceiveRejectionReason;
}

export interface OfficialApiIdentityObservationReceiveReceipt {
  readonly contract_version: typeof OFFICIAL_API_IDENTITY_OBSERVATION_RECEIVE_CONTRACT_VERSION;
  readonly producer: typeof OFFICIAL_API_IDENTITY_OBSERVATION_RECEIVE_PRODUCER;
  readonly status: OfficialApiIdentityObservationReceiveStatus;
  readonly observation: IdentityObservation | null;
  readonly topology: OfficialApiSemanticFactorGraphProjection;
  readonly rejections: readonly OfficialApiIdentityObservationReceiveRejection[];
}

export function receiveOfficialApiIdentityObservation(input: Readonly<{
  readonly identityObservation?: unknown;
  readonly semanticFactorGraph?: unknown;
  readonly sourceText?: string | null;
}>): OfficialApiIdentityObservationReceiveReceipt {
  const topology = inspectOfficialApiSemanticFactorGraphProjection(input.semanticFactorGraph);
  const rejections: OfficialApiIdentityObservationReceiveRejection[] = [];
  const explicit = readExplicitObservation(input.identityObservation, rejections);
  const mentions = explicit === undefined
    ? salvageMentions(input.semanticFactorGraph)
    : explicit.mentions;
  const unresolved = explicit === undefined ? [] : [...(explicit.unresolved_spans ?? [])];
  const grounded = groundObservationParts(mentions, unresolved, input.sourceText, rejections);
  if (topology.audit?.status === "rejected") {
    rejections.push(Object.freeze({ reason: "topology_rejected" as const }));
  }
  const observation = toObservation(grounded.mentions, grounded.unresolved);
  const status = receiveStatus(observation, topology, rejections);
  return Object.freeze({
    contract_version: OFFICIAL_API_IDENTITY_OBSERVATION_RECEIVE_CONTRACT_VERSION,
    producer: OFFICIAL_API_IDENTITY_OBSERVATION_RECEIVE_PRODUCER,
    status,
    observation,
    topology,
    rejections: Object.freeze(dedupeRejections(rejections))
  });
}

function readExplicitObservation(
  value: unknown,
  rejections: OfficialApiIdentityObservationReceiveRejection[]
): IdentityObservation | undefined {
  if (value === undefined) return undefined;
  const parsed = IdentityObservationSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  rejections.push(Object.freeze({ reason: "identity_observation_invalid" as const }));
  return undefined;
}

function salvageMentions(graphValue: unknown): readonly IdentityObservationMention[] {
  if (typeof graphValue !== "object" || graphValue === null || Array.isArray(graphValue)) {
    return [];
  }
  const factors = (graphValue as { readonly factors?: unknown }).factors;
  if (!Array.isArray(factors)) return [];
  const mentions: IdentityObservationMention[] = [];
  for (const factor of factors) {
    const mention = mentionFromUnknown(factor);
    if (mention === null) continue;
    mentions.push(mention);
    if (mentions.length >= IDENTITY_OBSERVATION_MENTION_LIMIT) break;
  }
  return Object.freeze(mentions);
}

function mentionFromUnknown(value: unknown): IdentityObservationMention | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.surface !== "string" || record.surface.length === 0 || record.surface.length > 512) {
    return null;
  }
  const occurrence = SourceOccurrenceSchema.safeParse(record.source_occurrence ?? 0);
  if (!occurrence.success) return null;
  const lemma = SemanticIdentitySchema.safeParse(record.semantic_identity);
  return Object.freeze({
    surface: record.surface,
    source_occurrence: occurrence.data,
    ...(lemma.success ? { proposed_semantic_identity: lemma.data } : {})
  });
}

function groundObservationParts(
  mentions: readonly IdentityObservationMention[],
  unresolved: readonly IdentityObservationSpan[],
  sourceText: string | null | undefined,
  rejections: OfficialApiIdentityObservationReceiveRejection[]
): Readonly<{
  mentions: readonly IdentityObservationMention[];
  unresolved: readonly IdentityObservationSpan[];
}> {
  if (sourceText === null || sourceText === undefined) {
    return { mentions, unresolved };
  }
  const groundedMentions = mentions.filter((mention) => isSourceGrounded(sourceText, mention));
  const groundedUnresolved = unresolved.filter((span) => isSourceGrounded(sourceText, span));
  if (groundedMentions.length !== mentions.length || groundedUnresolved.length !== unresolved.length) {
    rejections.push(Object.freeze({ reason: "mention_not_source_grounded" as const }));
  }
  return {
    mentions: Object.freeze(groundedMentions),
    unresolved: Object.freeze(groundedUnresolved)
  };
}

function isSourceGrounded(
  sourceText: string,
  item: Readonly<{ readonly surface: string; readonly source_occurrence?: number }>
): boolean {
  return findSourceTextOccurrence(sourceText, item.surface, item.source_occurrence ?? 0) !== null;
}

function toObservation(
  mentions: readonly IdentityObservationMention[],
  unresolved: readonly IdentityObservationSpan[]
): IdentityObservation | null {
  if (mentions.length === 0 && unresolved.length === 0) return null;
  return IdentityObservationSchema.parse({
    contract_version: IDENTITY_OBSERVATION_CONTRACT_VERSION,
    producer: IDENTITY_OBSERVATION_PRODUCER,
    mentions,
    ...(unresolved.length === 0 ? {} : { unresolved_spans: unresolved })
  });
}

function receiveStatus(
  observation: IdentityObservation | null,
  topology: OfficialApiSemanticFactorGraphProjection,
  rejections: readonly OfficialApiIdentityObservationReceiveRejection[]
): OfficialApiIdentityObservationReceiveStatus {
  if (observation === null) return "empty";
  if (rejections.length > 0 || topology.audit?.status === "rejected") return "partial";
  return "complete";
}

function dedupeRejections(
  rejections: readonly OfficialApiIdentityObservationReceiveRejection[]
): readonly OfficialApiIdentityObservationReceiveRejection[] {
  const seen = new Set<string>();
  const unique: OfficialApiIdentityObservationReceiveRejection[] = [];
  for (const rejection of rejections) {
    if (seen.has(rejection.reason)) continue;
    seen.add(rejection.reason);
    unique.push(rejection);
  }
  return unique;
}
