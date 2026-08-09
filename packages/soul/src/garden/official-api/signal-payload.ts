import { createHash } from "node:crypto";
import {
  SignalSource,
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  type GardenProviderKind
} from "@do-soul/alaya-protocol";
import {
  buildTurnExcerpt,
  clampFullTurnContent,
  type OfficialApiSignalDraft
} from "../official-api-signal-parser.js";
import { buildSchemaGroundedRawPayload } from "../schema-grounding.js";
import { buildSourceVerificationText } from "../grounding/source-assertion.js";
import type { OfficialApiSourceGroundingAudit } from "./source-grounding.js";

export function buildOfficialCandidateSignal(input: {
  readonly draft: OfficialApiSignalDraft;
  readonly workspaceId: string;
  readonly runId: string;
  readonly surfaceId: string | null;
  readonly normalizedTurnContent: string;
  readonly groundingSourceText: string;
  readonly confidence: number;
  readonly temporalProjection: OfficialApiSignalDraft["temporal_projection"];
  readonly distilledFact: string | undefined;
  readonly providerKind: GardenProviderKind;
  readonly signalId: string;
  readonly createdAt: string;
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
  return {
    matched_text: draft.matched_text,
    ...(draft.source_locator === undefined ? {} : { source_locator: draft.source_locator }),
    ...(input.distilledFact === undefined ? {} : { distilled_fact: input.distilledFact }),
    ...(input.temporalProjection === undefined ? {} : { temporal_projection: input.temporalProjection }),
    ...(draft.preference_profile === undefined ? {} : { preference_profile: draft.preference_profile }),
    ...(draft.fact_frame === undefined ? {} : { fact_frame: draft.fact_frame }),
    ...(draft.semantic_factor_graph === undefined
      ? {}
      : { semantic_factor_graph: draft.semantic_factor_graph }),
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
    full_turn_content: buildBoundedSourceVerificationText(input),
    ...buildVerifiedUserAssertionReceipt(input)
  };
}

function buildBoundedSourceVerificationText(
  input: Parameters<typeof buildOfficialCandidateSignal>[0]
): string {
  if (input.sourceGrounding.status === "grounded") {
    return buildSourceVerificationText(
      input.groundingSourceText,
      input.sourceGrounding.source_assertion
    );
  }
  return clampFullTurnContent(input.groundingSourceText);
}

function buildVerifiedUserAssertionReceipt(
  input: Parameters<typeof buildOfficialCandidateSignal>[0]
): Readonly<Record<string, string>> {
  if (input.draft.source_locator === undefined || input.sourceGrounding.status !== "grounded") {
    return {};
  }
  const digest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: input.workspaceId,
      run_id: input.runId,
      surface_id: input.surfaceId,
      source_assertion: input.sourceGrounding.source_assertion,
      source_corpus: input.groundingSourceText
    }), "utf8")
    .digest("hex");
  return {
    verified_user_assertion_source_hash: formatVerifiedUserAssertionSourceHash(digest)
  };
}
