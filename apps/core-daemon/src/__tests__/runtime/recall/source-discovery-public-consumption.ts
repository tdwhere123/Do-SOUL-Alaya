import {
  BoundSourceInterpretationSchema,
  locateSourceInterpretation,
  SoulMemorySearchRequestSchema,
  sourceRecallTarget,
  type EnumerationPolicy,
  type SoulMemorySearchRequest,
  type SoulMemorySearchResponse,
  type SourceLocatedInterpretation
} from "@do-soul/alaya-protocol";
import type { ConditionalFieldExecutionReceipt } from "@do-soul/alaya-core";
import { deploymentProposal } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment-proposal.fixture.js";
import {
  SqliteEvidenceCapsuleRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { FirstExposurePage } from
  "../../../../../../apps/bench-runner/src/runs/measurement/first-exposure-session.js";
import { fieldContractSha256 } from "../../../../../../packages/core/src/shared/field-hash.js";
import { uuidFromHex } from "../../../../../../packages/core/src/memory/evidence-create/source-observation-identity.js";
import {
  canaryContentScopeCheck,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import {
  identityAssociationCap
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import type { RecallUsageToolCallContext } from "../../../mcp-memory/recall/recall-usage-handlers.js";

export const PUBLIC_CONSUMPTION_PROTOCOL = Object.freeze({
  protocol_id: "public-source-consumption-v2",
  attribution_contract: "published-proposal-exposure-before-complete-v1",
  base_sha: "dece964bde5b0cce993c9f3218dea04cc53b95e2",
  base_tree: "ec6ddf1279512cee6f5a4fead599bc974cd7f40b",
  primary_metric: "cumulative_native_visits_to_first_complete_required_context",
  max_results: 8 as number,
  historical_max_results: 1 as number,
  payload_byte_budget: 4096,
  max_membership_pages: 16,
  max_payload_expansions_per_target: 16,
  native_observer_work_limit: 7,
  request_work_units: 10_000,
  request_memory_bytes: 1_000_000,
  turn_cap_formula: "max_membership_pages * (1 + max_results * max_payload_expansions_per_target)"
});

export type LookupMode = "proposal" | "source_text";
export type ResultView = "source_only" | "mixed" | "memory_only";
/** Protocol enumeration identities; only `native_query` is a live ordinary execution route. */
export type Enumeration = EnumerationPolicy;
export const LIVE_ORDINARY_ENUMERATION = "native_query" as const satisfies Enumeration;
export const LIVE_ORDINARY_ENUMERATIONS = [LIVE_ORDINARY_ENUMERATION] as const;
export type Cost = number | "unavailable";
export type ConsumptionStopReason =
  | "continuation_exhausted"
  | "membership_page_cap"
  | "index_invalidated"
  | "declared_turn_cap";
export type CapRemainder = "unread_after_cap" | "none";
export type ConsumptionAttribution =
  | "hit"
  | "qualification"
  | "resource"
  | "payload"
  | "unknown";
export type FirstPageOmissionAttribution =
  | "included"
  | "order"
  | "absent"
  | "unknown";

export type PublicConsumer = (
  request: SoulMemorySearchRequest,
  context: RecallUsageToolCallContext
) => Promise<SoulMemorySearchResponse>;

export type PublicContinuationRef = Readonly<{
  readonly continuation_id: string;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly cursor: string;
}>;

export type PublicPayloadContinuationRef = Readonly<{
  readonly target_kind: string;
  readonly root_id: string | "unavailable";
  readonly source_version: string | "unavailable";
  readonly content_digest: string | "unavailable";
  readonly start_offset: number | "unavailable";
  readonly byte_budget: number | "unavailable";
}>;

export type PublicPayloadChunk = Readonly<{
  readonly root_id: string;
  readonly source_version: string | "unavailable";
  readonly content_digest: string | "unavailable";
  readonly content_start: number | "unavailable";
  readonly content_end: number | "unavailable";
  readonly content_complete: boolean | "unavailable";
  readonly retained_extent: string | "unavailable";
  readonly preview_omitted: boolean;
  readonly chunk_utf8_bytes: number | "unavailable";
  readonly chunk_sha256: string | "unavailable";
  readonly chunk_text: string | "unavailable";
}>;

export type PublicStepReceipt = Readonly<{
  readonly query_id: string;
  readonly interpretation_id: string;
  readonly snapshot_id: string;
  readonly actual: Readonly<{
    readonly native_visits: Cost;
    readonly native_bytes: Cost;
    readonly retained_bytes_current: Cost;
  }> | "unavailable";
}>;

export type PublicStepExchange = Readonly<{
  readonly step_index: number;
  readonly request: Readonly<{
    readonly query: string;
    readonly interpretation_proposal: SoulMemorySearchRequest["interpretation_proposal"] | null;
    readonly continuation: PublicContinuationRef | null;
    readonly payload_continuation: PublicPayloadContinuationRef | null;
  }>;
  readonly response: Readonly<{
    readonly delivery_id: string | "unavailable";
    readonly page_purpose: string | "unavailable";
    readonly chunks: readonly PublicPayloadChunk[];
    readonly source_lookups: readonly Readonly<{
      readonly target: NonNullable<SoulMemorySearchResponse["results"][number]["target"]>;
      readonly reasons: SoulMemorySearchResponse["results"][number]["source_lookup_reasons"] | "unavailable";
    }>[];
  }>;
  readonly receipt: PublicStepReceipt | "unavailable";
}>;

export type ConsumptionStep = Readonly<{
  readonly purpose: string;
  readonly membership_page: number;
  readonly payload_expansions: number;
  readonly cumulative_native_visits: Cost;
  readonly cumulative_native_bytes: Cost;
  readonly retained_bytes_current: Cost;
  readonly public_identities: readonly string[];
  readonly source_bodies: Readonly<Record<string, string>>;
  readonly preview_complete: Readonly<Record<string, boolean>>;
  readonly logical_index: string | undefined;
  readonly payload_completeness: string | undefined;
  readonly public_exchange: PublicStepExchange;
  readonly assembly_gap: readonly string[];
  readonly stop_reason?: ConsumptionStopReason;
  readonly discarded_capped_incomplete_root_ids?: readonly string[];
  readonly cap_remainder?: CapRemainder;
}>;

export type ConsumptionTrace = Readonly<{
  readonly first_exposure: FirstExposurePage | null;
  readonly first_page_identities: readonly string[];
  readonly first_page_preview_complete: Readonly<Record<string, boolean>>;
  readonly steps: readonly ConsumptionStep[];
  readonly termination: ConsumptionStep;
  readonly discarded_capped_incomplete_root_ids: readonly string[];
  readonly cap_remainder: CapRemainder;
  readonly assembly_gap: readonly string[];
  readonly expansions_by_target: Readonly<Record<string, number>>;
}>;

export function publicSearchRequest(
  canary: CanaryCase,
  lookup: LookupMode,
  view: ResultView,
  enumeration: Enumeration,
  maxResults: number = PUBLIC_CONSUMPTION_PROTOCOL.max_results
): SoulMemorySearchRequest {
  return SoulMemorySearchRequestSchema.parse({
    query: canary.original_query,
    max_results: maxResults,
    scope_class: null,
    dimension: null,
    domain_tags: null,
    result_kind_view: view,
    enumeration_policy: enumeration,
    // Explicit graph control shares native nomination, but its conditional proof can differ.
    ...(lookup === "proposal" ? { interpretation_proposal: deploymentProposal(canary.original_query) } : {}),
    protocol_version: 1,
    supported_result_kinds: ["memory_entry", "source_evidence"],
    supports_source_evidence: true,
    supports_product_updates: true,
    ...(enumeration === "associative" ? { cap_contracts: [identityAssociationCap()] } : {})
  });
}

export function tapRecallReceipts<T extends { recall: (...args: never[]) => Promise<unknown> }>(
  service: T,
  bag: ConditionalFieldExecutionReceipt[]
): T {
  const inner = service.recall.bind(service) as T["recall"];
  service.recall = (async (params: never) => {
    const result = await inner(params) as { readonly execution_receipt?: ConditionalFieldExecutionReceipt };
    if (result.execution_receipt !== undefined) bag.push(result.execution_receipt);
    return result;
  }) as T["recall"];
  return service;
}

export function scoreConsumption(
  canary: CanaryCase,
  intendedRootId: string,
  trace: ConsumptionTrace,
  view?: ResultView,
  expectedSourceBody?: string
): Readonly<{
  readonly first_page_includes_intended: boolean;
  readonly first_page_position: number | null;
  readonly first_page_omission: boolean;
  readonly first_page_omission_attribution: FirstPageOmissionAttribution;
  readonly first_complete_step: number | null;
  readonly primary_native_visits: Cost | "miss";
  readonly first_complete_costs: Readonly<{
    readonly cumulative_native_visits: Cost;
    readonly cumulative_native_bytes: Cost;
    readonly retained_bytes_current: Cost;
    readonly membership_page: number;
    readonly payload_expansions: number;
  }> | null;
  readonly content: ReturnType<typeof canaryContentScopeCheck>;
  readonly consumption_attribution: ConsumptionAttribution;
}> {
  const firstPosition = trace.first_page_identities.indexOf(intendedRootId);
  const firstPageIncludes = firstPosition >= 0;
  let firstComplete: number | null = null;
  for (const [index, step] of trace.steps.entries()) {
    const body = step.source_bodies[intendedRootId];
    if (step.preview_complete[intendedRootId] === true && body?.includes(canary.intended) &&
      (expectedSourceBody === undefined || body === expectedSourceBody)) {
      firstComplete = index;
      break;
    }
  }
  const content = canaryContentScopeCheck(trace.termination.source_bodies[intendedRootId] ?? "", canary);
  const seenOnPublic = trace.steps.some((step) => step.public_identities.includes(intendedRootId)
    || Object.keys(step.source_bodies).includes(intendedRootId));
  const resourceRejected = publicRunResourceRejected(trace);
  return {
    first_page_includes_intended: firstPageIncludes,
    first_page_position: firstPageIncludes ? firstPosition + 1 : null,
    first_page_omission: !firstPageIncludes,
    first_page_omission_attribution: firstPageOmissionAttribution({
      firstPageIncludes,
      seenOnPublic,
      view,
      resourceRejected
    }),
    first_complete_step: firstComplete,
    primary_native_visits: firstComplete === null
      ? "miss"
      : trace.steps[firstComplete]!.cumulative_native_visits,
    first_complete_costs: firstComplete === null ? null : {
      cumulative_native_visits: trace.steps[firstComplete]!.cumulative_native_visits,
      cumulative_native_bytes: trace.steps[firstComplete]!.cumulative_native_bytes,
      retained_bytes_current: trace.steps[firstComplete]!.retained_bytes_current,
      membership_page: trace.steps[firstComplete]!.membership_page,
      payload_expansions: trace.steps[firstComplete]!.payload_expansions
    },
    content,
    consumption_attribution: consumptionAttribution({
      completed: firstComplete !== null,
      view,
      seenOnPublic,
      resourceRejected
    })
  };
}

export function insertLocatedBoundGist(
  database: StorageDatabase,
  objectKey: string,
  source: string,
  rootId: string,
  digest: string,
  evidenceObjectId: string | null,
  located: SourceLocatedInterpretation,
  workspaceId: string,
  runId: string,
  now: string
): string {
  const objectId = uuidFromHex(fieldContractSha256(objectKey));
  const bound = boundCandidateGist(
    source, rootId, digest, evidenceObjectId, located, workspaceId
  );
  // Interpretation provenance is not a SourceRecord alias. Retain its own text
  // through the capsule owner so native capture can admit this standalone root.
  const capsules = new SqliteEvidenceCapsuleRepo(database);
  database.connection.transaction(() => capsules.createInCurrentTransaction({
    object_id: objectId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: now,
    updated_at: now,
    created_by: "test",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "source interpretation", keywords: [], summary: "Located proposal witness" },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: JSON.stringify(bound),
    excerpt: source,
    source_hash: null,
    run_id: runId,
    workspace_id: workspaceId,
    surface_id: null
  }))();
  return objectId;
}

function boundCandidateGist(
  source: string,
  rootId: string,
  digest: string,
  evidenceObjectId: string | null,
  located: SourceLocatedInterpretation,
  workspaceId: string
) {
  if (located.outcome !== "candidates") {
    throw new Error("bound gist requires candidate outcome");
  }
  const [start, end] = located.assertion_binding.source_span;
  if (source.slice(start, end) !== located.assertion_binding.text) {
    throw new Error("assertion slice does not match source body");
  }
  if (located.source_corpus_digest !== fieldContractSha256(source)) {
    throw new Error("source identity does not match planted body");
  }
  return BoundSourceInterpretationSchema.parse({
    ...located,
    source_target: sourceRecallTarget({
      workspace_id: workspaceId,
      root_kind: "source_record",
      root_id: rootId,
      source_version: "v1",
      content_digest: digest,
      evidence_object_id: evidenceObjectId
    })
  });
}

export function insertBoundGist(
  database: StorageDatabase,
  objectId: string,
  source: string,
  rootId: string,
  digest: string,
  evidenceObjectId: string | null,
  relation: NonNullable<CanaryCase["sketch"]>,
  workspaceId: string,
  runId: string,
  now: string
): string {
  const located = locateSourceInterpretation({
    source,
    artifactKey: objectId,
    sha256: fieldContractSha256,
    assertion: { assertion_id: 1, text: source, source_span: [0, source.length] },
    response: {
      kind: "received",
      value: {
        interpretations: [{
          assertion_id: 1,
          relations: [{
            predicate: { text: relation.predicate },
            arguments: (relation.arguments ?? []).map((item) => ({ role: item.role, phrase: { text: item.phrase } })),
            qualifiers: (relation.qualifiers ?? []).map((item) => ({ role: item.role, phrase: { text: item.phrase } }))
          }]
        }]
      }
    }
  });
  if (located.outcome !== "candidates") {
    throw new Error(`locate failed: ${JSON.stringify(located.diagnostics)}`);
  }
  return insertLocatedBoundGist(
    database, objectId, source, rootId, digest, evidenceObjectId, located, workspaceId, runId, now
  );
}

function publicRunResourceRejected(trace: ConsumptionTrace): boolean {
  return trace.steps.some((step) =>
    step.payload_completeness === "resource_rejected" || step.logical_index === "resource_rejected");
}

function firstPageOmissionAttribution(input: Readonly<{
  readonly firstPageIncludes: boolean;
  readonly seenOnPublic: boolean;
  readonly view: ResultView | undefined;
  readonly resourceRejected: boolean;
}>): FirstPageOmissionAttribution {
  if (input.firstPageIncludes) return "included";
  if (input.view === "memory_only") return "absent";
  if (input.seenOnPublic) return "order";
  if (input.resourceRejected) return "unknown";
  return "unknown";
}

function consumptionAttribution(input: Readonly<{
  readonly completed: boolean;
  readonly view: ResultView | undefined;
  readonly seenOnPublic: boolean;
  readonly resourceRejected: boolean;
}>): ConsumptionAttribution {
  if (input.completed) return "hit";
  if (input.view === "memory_only") return "qualification";
  if (input.resourceRejected) return "resource";
  if (!input.seenOnPublic) return "unknown";
  return "payload";
}
