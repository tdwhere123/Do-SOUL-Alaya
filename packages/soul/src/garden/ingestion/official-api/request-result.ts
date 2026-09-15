import {
  parseOfficialApiSignalsReceipt,
  type OfficialApiSignalDraft,
  type OfficialApiSignalParseOptions
} from "../official-api-signal-parser.js";
import {
  computeOfficialApiSourceCorpusIdentity,
  type OfficialApiExtractionRequest
} from "./extraction-request.js";
import type { SourceAssertionCatalogPage } from
  "../../triage/grounding/source-locator/assertion-catalog.js";
import { buildOfficialApiSourceAssertions } from "../../triage/grounding/source-locator.js";
import { resolvePreferenceAwareSourceGrounding } from "../../triage/grounding/preference-profile.js";
import { groundOfficialApiDraft } from "./source-grounding.js";
import {
  SELECTED_SOURCE_BOUND_F3_CAPABILITY,
  type SourceBoundF3Capability
} from "../../extraction/semantic-factors/source-bound-seal.js";

const OFFICIAL_API_REQUEST_RECEIVE_CONTRACT_VERSION = 1 as const;
const OFFICIAL_API_REQUEST_RECEIVE_PRODUCER =
  "official-api-request-receive-v1" as const;
export const OFFICIAL_API_GARDEN_COMPILE_CONTRACT_VERSION = 1 as const;
export const OFFICIAL_API_GARDEN_COMPILE_PRODUCER =
  "official-api-garden-compile-v1" as const;
export const OFFICIAL_API_SEMANTIC_PRESERVATION_CLAIM =
  "not_claimed_by_request_completion" as const;

export type OfficialApiCatalogEligibility =
  | "eligible_assertions_present"
  | "catalog_produced_no_eligible_assertion";

type OfficialApiRequestReceiveStatus = "complete" | "partial";

type OfficialApiRequestEntryRejectionReason =
  | "locator_outside_batch"
  | "source_grounding_rejected"
  | "source_generation_mismatch"
  | "source_assertion_mismatch";

export interface OfficialApiRequestEntryRejection {
  readonly index: number;
  readonly reason: OfficialApiRequestEntryRejectionReason;
  readonly assertion_id?: number;
}

export interface OfficialApiRequestReceiveReceipt {
  readonly contract_version: typeof OFFICIAL_API_REQUEST_RECEIVE_CONTRACT_VERSION;
  readonly producer: typeof OFFICIAL_API_REQUEST_RECEIVE_PRODUCER;
  readonly status: OfficialApiRequestReceiveStatus;
  readonly drafts: readonly OfficialApiSignalDraft[];
  readonly rejections: readonly OfficialApiRequestEntryRejection[];
}

export interface OfficialApiGardenCompilePendingBatch {
  readonly source_corpus_identity: string;
  readonly batch_index: number;
  readonly batch_count: number;
  readonly assertion_ids: readonly number[];
}

export interface OfficialApiGardenCompileReceipt {
  readonly contract_version: typeof OFFICIAL_API_GARDEN_COMPILE_CONTRACT_VERSION;
  readonly producer: typeof OFFICIAL_API_GARDEN_COMPILE_PRODUCER;
  readonly status: "partial";
  readonly drafts: readonly OfficialApiSignalDraft[];
  readonly rejections: readonly OfficialApiRequestEntryRejection[];
  readonly pending_batches: readonly OfficialApiGardenCompilePendingBatch[];
  readonly catalog: Pick<
    SourceAssertionCatalogPage,
    "inventory_count" | "coverage" | "residual" | "next_cursor"
  >;
}

const REQUIRE_GRAPH_FOR_MEMBERSHIP: Readonly<Record<SourceBoundF3Capability, boolean>> = {
  f0_f2_only: false,
  identities_only: false,
  identities_and_topology: true
};

const DEPENDENT_SCOPE_NAMES = new Set([
  "condition",
  "agent",
  "negation",
  "not",
  "unless",
  "promiser"
]);

/** Completion describes the extraction request, not exhaustive memory formation. */
export function classifyOfficialApiRequestResult(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
) {
  if (sourceCorpus !== undefined && computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    throw new Error("official API completed result source corpus differs from its request");
  }
  const envelope: unknown = JSON.parse(rawJson);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope) ||
      !("signals" in envelope) || !Array.isArray(envelope.signals)) {
    throw new Error("official API completed result requires a signals array");
  }
  const received = receiveOfficialApiRequestSignals(rawJson, request, sourceCorpus);
  if (received.status !== "complete" || received.drafts.length !== envelope.signals.length) {
    throw new Error("official API completed result contains rejected signal entries");
  }
  const assertions = new Map(request.source_assertions.map((assertion) => [assertion.assertion_id, assertion.text]));
  for (const draft of received.drafts) {
    const assertion = draft.source_locator === undefined ? undefined : assertions.get(draft.source_locator.assertion_id);
    if (assertion === undefined || resolvePreferenceAwareSourceGrounding({
      sourceCorpus: assertion, proposedMatch: draft.matched_text, proposal: draft.preference_profile
    }).resolution.status !== "grounded") {
      throw new Error("official API completed result requires a grounded source locator");
    }
  }
  return Object.freeze({
    status: received.drafts.length === 0 ? "completed_empty" as const : "completed_signals" as const,
    drafts: received.drafts
  });
}

export function catalogEligibilityOfAssertionCount(
  count: number
): OfficialApiCatalogEligibility {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError("assertion count must be a non-negative integer");
  }
  return count === 0
    ? "catalog_produced_no_eligible_assertion"
    : "eligible_assertions_present";
}

export function catalogEligibilityOfRequest(
  request: Pick<OfficialApiExtractionRequest, "source_assertions">
): OfficialApiCatalogEligibility {
  return catalogEligibilityOfAssertionCount(request.source_assertions.length);
}

/** Request completion, catalog coverage, and semantic preservation are distinct layers. */
export function officialApiRequestCoverageLayers(
  request: Pick<OfficialApiExtractionRequest, "source_assertions">,
  requestProcessing: "completed_empty" | "completed_signals",
  catalog: Pick<SourceAssertionCatalogPage, "inventory_count" | "coverage" | "residual">
) {
  return Object.freeze({
    request_processing: requestProcessing,
    request_assertion_count: request.source_assertions.length,
    catalog_eligibility: catalogEligibilityOfAssertionCount(catalog.inventory_count),
    catalog_coverage: catalog.coverage,
    catalog_residual_count: catalog.residual.length,
    semantic_preservation: OFFICIAL_API_SEMANTIC_PRESERVATION_CLAIM
  });
}

export function parseOfficialApiRequestSignals(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
): readonly OfficialApiSignalDraft[] {
  const received = receiveOfficialApiRequestSignals(rawJson, request, sourceCorpus);
  if (received.status !== "complete") {
    throw new Error("official API request receive is incomplete");
  }
  return received.drafts;
}

export function createOfficialApiGardenCompileReceipt(input: {
  readonly drafts: readonly OfficialApiSignalDraft[];
  readonly rejections: readonly OfficialApiRequestEntryRejection[];
  readonly pending: readonly OfficialApiExtractionRequest[];
  readonly catalog: Pick<
    SourceAssertionCatalogPage,
    "inventory_count" | "coverage" | "residual" | "next_cursor"
  >;
}): OfficialApiGardenCompileReceipt {
  return Object.freeze({
    contract_version: OFFICIAL_API_GARDEN_COMPILE_CONTRACT_VERSION,
    producer: OFFICIAL_API_GARDEN_COMPILE_PRODUCER,
    status: "partial" as const,
    drafts: Object.freeze([...input.drafts]),
    rejections: Object.freeze([...input.rejections]),
    pending_batches: Object.freeze(input.pending.map((request) => Object.freeze({
      source_corpus_identity: request.source_corpus_identity,
      batch_index: request.batch_index,
      batch_count: request.batch_count,
      assertion_ids: Object.freeze(request.source_assertions.map((assertion) => assertion.assertion_id))
    }))),
    catalog: Object.freeze({
      inventory_count: input.catalog.inventory_count,
      coverage: input.catalog.coverage,
      residual: input.catalog.residual,
      next_cursor: input.catalog.next_cursor
    })
  });
}

export function receiveOfficialApiRequestSignals(
  rawJson: string,
  request: OfficialApiExtractionRequest,
  sourceCorpus?: string
): OfficialApiRequestReceiveReceipt {
  const parsed = parseOfficialApiSignalsReceipt(rawJson, membershipParseOptions());
  const bound = requestBoundRejections(request, sourceCorpus, parsed.drafts.length);
  if (bound !== null) {
    return toReceiveReceipt("partial", [], bound);
  }
  const isolated = isolateRequestDrafts(parsed.drafts, request, sourceCorpus);
  const drafts = demoteDependentSemantics(isolated.drafts, isolated.rejectedDrafts);
  const status = isolated.rejections.length === 0
    && parsed.recoveryKind === "none"
    && parsed.discardedCount === 0
    ? "complete"
    : "partial";
  return toReceiveReceipt(status, drafts, isolated.rejections);
}

function membershipParseOptions(): OfficialApiSignalParseOptions {
  return {
    requireSemanticFactorGraph:
      REQUIRE_GRAPH_FOR_MEMBERSHIP[SELECTED_SOURCE_BOUND_F3_CAPABILITY]
  };
}

function requestBoundRejections(
  request: OfficialApiExtractionRequest,
  sourceCorpus: string | undefined,
  draftCount: number
): readonly OfficialApiRequestEntryRejection[] | null {
  if (sourceCorpus === undefined) {
    return null;
  }
  const indexes = Math.max(draftCount, 1);
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    return Array.from({ length: indexes }, (_, index) => Object.freeze({
      index,
      reason: "source_generation_mismatch" as const
    }));
  }
  const catalog = new Map(buildOfficialApiSourceAssertions(sourceCorpus)
    .map((assertion) => [assertion.assertion_id, assertion.text]));
  if (request.source_assertions.some((assertion) => catalog.get(assertion.assertion_id) !== assertion.text)) {
    return Array.from({ length: indexes }, (_, index) => Object.freeze({
      index,
      reason: "source_assertion_mismatch" as const
    }));
  }
  return null;
}

function isolateRequestDrafts(
  parsed: readonly OfficialApiSignalDraft[],
  request: OfficialApiExtractionRequest,
  sourceCorpus: string | undefined
): Readonly<{
  drafts: readonly OfficialApiSignalDraft[];
  rejectedDrafts: readonly OfficialApiSignalDraft[];
  rejections: readonly OfficialApiRequestEntryRejection[];
}> {
  const allowedIds = new Set(request.source_assertions.map(({ assertion_id }) => assertion_id));
  const drafts: OfficialApiSignalDraft[] = [];
  const rejectedDrafts: OfficialApiSignalDraft[] = [];
  const rejections: OfficialApiRequestEntryRejection[] = [];
  parsed.forEach((draft, index) => {
    const assertionId = draft.source_locator?.assertion_id;
    if (draft.source_locator !== undefined && !allowedIds.has(draft.source_locator.assertion_id)) {
      rejectedDrafts.push(draft);
      rejections.push(Object.freeze({
        index,
        reason: "locator_outside_batch" as const,
        ...(assertionId === undefined ? {} : { assertion_id: assertionId })
      }));
      return;
    }
    if (sourceCorpus === undefined) {
      drafts.push(draft);
      return;
    }
    const grounded = groundOfficialApiDraft(draft, sourceCorpus);
    if (grounded.status === "rejected") {
      rejectedDrafts.push(draft);
      rejections.push(Object.freeze({
        index,
        reason: "source_grounding_rejected" as const,
        ...(assertionId === undefined ? {} : { assertion_id: assertionId })
      }));
      return;
    }
    drafts.push(grounded.draft);
  });
  return {
    drafts: Object.freeze(drafts),
    rejectedDrafts: Object.freeze(rejectedDrafts),
    rejections: Object.freeze(rejections)
  };
}

function demoteDependentSemantics(
  drafts: readonly OfficialApiSignalDraft[],
  rejectedDrafts: readonly OfficialApiSignalDraft[]
): readonly OfficialApiSignalDraft[] {
  if (rejectedDrafts.length === 0) {
    return drafts;
  }
  return Object.freeze(drafts.map((draft) =>
    dependsOnRejectedSibling(draft, rejectedDrafts) ? sourceOnlyDraft(draft) : draft
  ));
}

function dependsOnRejectedSibling(
  draft: OfficialApiSignalDraft,
  rejectedDrafts: readonly OfficialApiSignalDraft[]
): boolean {
  const ownText = draft.matched_text;
  for (const surface of scopeSurfaces(draft)) {
    if (ownText.includes(surface)) {
      continue;
    }
    if (rejectedDrafts.some((sibling) => sibling.matched_text.includes(surface))) {
      return true;
    }
  }
  return false;
}

function scopeSurfaces(draft: OfficialApiSignalDraft): readonly string[] {
  const graph = draft.semantic_factor_graph;
  if (graph === undefined) {
    return [];
  }
  const referencedIds = new Set<string>();
  for (const proposition of graph.propositions) {
    for (const argument of proposition.arguments) {
      if (DEPENDENT_SCOPE_NAMES.has(argument.binding_identity)) {
        referencedIds.add(argument.reference_id);
      }
    }
  }
  return graph.factors
    .filter((factor) => referencedIds.has(factor.factor_id) || DEPENDENT_SCOPE_NAMES.has(factor.factor_id))
    .map((factor) => factor.surface);
}

function sourceOnlyDraft(draft: OfficialApiSignalDraft): OfficialApiSignalDraft {
  const {
    semantic_factor_graph: _graph,
    semantic_factor_graph_projection: _projection,
    fact_frame: _frame,
    ...rest
  } = draft;
  return Object.freeze(rest);
}

function toReceiveReceipt(
  status: OfficialApiRequestReceiveStatus,
  drafts: readonly OfficialApiSignalDraft[],
  rejections: readonly OfficialApiRequestEntryRejection[]
): OfficialApiRequestReceiveReceipt {
  return Object.freeze({
    contract_version: OFFICIAL_API_REQUEST_RECEIVE_CONTRACT_VERSION,
    producer: OFFICIAL_API_REQUEST_RECEIVE_PRODUCER,
    status: rejections.length > 0 ? "partial" : status,
    drafts: Object.freeze([...drafts]),
    rejections: Object.freeze([...rejections])
  });
}
