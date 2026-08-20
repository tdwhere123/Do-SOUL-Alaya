import { createHash } from "node:crypto";
import {
  SignalSource,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionV2SourceHash,
  type ConversationMessage,
  type GardenProviderKind
} from "@do-soul/alaya-protocol";
import {
  buildTurnExcerpt,
  clampFullTurnContent,
  type OfficialApiSignalDraft
} from "../official-api-signal-parser.js";
import { buildSchemaGroundedRawPayload } from "../schema-grounding.js";
import { buildOfficialApiVerifiedUserAssertionSource } from "../grounding/source-locator.js";
import type { OfficialApiSourceGroundingAudit } from "./source-grounding.js";
import { projectOfficialApiTimeConcern } from "./time-concern-projection.js";

export function buildOfficialCandidateSignal(input: {
  readonly draft: OfficialApiSignalDraft;
  readonly workspaceId: string;
  readonly runId: string;
  readonly surfaceId: string | null;
  readonly normalizedTurnContent: string;
  readonly turnMessages: readonly ConversationMessage[];
  readonly groundingSourceText: string;
  readonly confidence: number;
  readonly temporalProjection: OfficialApiSignalDraft["temporal_projection"];
  readonly temporalProjectionAudit?: OfficialApiSignalDraft["temporal_projection_audit"];
  readonly distilledFact: string | undefined;
  readonly providerKind: GardenProviderKind;
  readonly signalId: string;
  readonly createdAt: string;
  readonly sourceObservedAt: string;
  readonly sourceGrounding: OfficialApiSourceGroundingAudit;
}): Record<string, unknown> {
  const { draft } = input;
  return {
    signal_id: input.signalId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    surface_id: input.surfaceId,
    source: SignalSource.GARDEN_COMPILE,
    signal_kind: draft.signal_kind,
    object_kind: draft.object_kind,
    scope_hint: null,
    domain_tags: [],
    confidence: input.confidence,
    evidence_refs: draft.evidence_refs,
    ...(draft.canonical_entities === undefined ? {} : { canonical_entities: draft.canonical_entities }),
    source_memory_refs: draft.source_memory_refs,
    raw_payload: buildSchemaGroundedRawPayload({
      signalKind: draft.signal_kind,
      objectKind: draft.object_kind,
      confidence: input.confidence,
      rawPayload: buildOfficialRawPayload(input)
    }),
    created_at: input.createdAt
  };
}

function buildOfficialRawPayload(
  input: Parameters<typeof buildOfficialCandidateSignal>[0]
): Record<string, unknown> {
  const { draft } = input;
  const verifiedSource = buildVerifiedUserAssertionSource(input);
  const sourceVerificationText = verifiedSource?.source_corpus ?? clampFullTurnContent(
    input.groundingSourceText
  );
  const sourceLocator = verifiedSource?.source_locator ?? draft.source_locator;
  const timeConcern = projectOfficialApiTimeConcern({
    sourceAssertion: input.sourceGrounding.status === "grounded"
      ? input.sourceGrounding.source_assertion
      : input.groundingSourceText,
    sourceObservedAt: input.sourceObservedAt,
    temporalProjection: input.temporalProjection
  });
  return {
    matched_text: draft.matched_text,
    ...(sourceLocator === undefined ? {} : { source_locator: sourceLocator }),
    ...(draft.object_kind_projection === undefined ? {} : {
      object_kind_projection: draft.object_kind_projection
    }),
    ...(input.distilledFact === undefined ? {} : { distilled_fact: input.distilledFact }),
    ...(input.temporalProjection === undefined ? {} : { temporal_projection: input.temporalProjection }),
    ...(input.temporalProjectionAudit === undefined ? {} : {
      temporal_projection_audit: input.temporalProjectionAudit
    }),
    ...(timeConcern.payload === undefined ? {} : { time_concern: timeConcern.payload }),
    time_concern_projection_audit: timeConcern.audit,
    ...(draft.preference_profile === undefined ? {} : { preference_profile: draft.preference_profile }),
    ...(draft.fact_frame === undefined ? {} : { fact_frame: draft.fact_frame }),
    ...(draft.semantic_factor_graph === undefined
      ? {}
      : { semantic_factor_graph: draft.semantic_factor_graph }),
    ...(draft.semantic_factor_graph_projection === undefined
      ? {}
      : { semantic_factor_graph_projection: draft.semantic_factor_graph_projection }),
    ...(draft.canonical_entities === undefined || draft.canonical_entities.length === 0
      ? {}
      : { canonical_entities: draft.canonical_entities }),
    ...(input.sourceGrounding.status === "grounded"
      ? { source_assertion: input.sourceGrounding.source_assertion }
      : {}),
    source_grounding: input.sourceGrounding,
    proposed_matched_text: input.sourceGrounding.proposed_matched_text,
    ...(input.sourceGrounding.proposed_distilled_fact === undefined
      ? {}
      : { proposed_distilled_fact: input.sourceGrounding.proposed_distilled_fact }),
    provider_kind: input.providerKind,
    extraction_reason: draft.reason ?? "official_api",
    turn_content_excerpt: buildTurnExcerpt(input.groundingSourceText, draft.matched_text),
    full_turn_content: sourceVerificationText,
    ...buildVerifiedUserAssertionReceipt(input, verifiedSource)
  };
}

function buildVerifiedUserAssertionSource(
  input: Parameters<typeof buildOfficialCandidateSignal>[0]
): ReturnType<typeof buildOfficialApiVerifiedUserAssertionSource> {
  if (input.sourceGrounding.status !== "grounded") return null;
  return buildOfficialApiVerifiedUserAssertionSource(
    input.normalizedTurnContent,
    input.turnMessages,
    input.draft.source_locator,
    input.sourceGrounding.source_assertion
  );
}

function buildVerifiedUserAssertionReceipt(
  input: Parameters<typeof buildOfficialCandidateSignal>[0],
  verifiedSource: ReturnType<typeof buildOfficialApiVerifiedUserAssertionSource>
): Readonly<Record<string, string>> {
  if (verifiedSource === null || input.sourceGrounding.status !== "grounded") {
    return {};
  }
  const digest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: input.signalId,
      source_locator: verifiedSource.source_locator,
      workspace_id: input.workspaceId,
      run_id: input.runId,
      surface_id: input.surfaceId,
      source_assertion: input.sourceGrounding.source_assertion,
      source_corpus: verifiedSource.source_corpus
    }), "utf8")
    .digest("hex");
  return {
    verified_user_assertion_source_hash: formatVerifiedUserAssertionV2SourceHash(digest)
  };
}
