import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  locateSourceInterpretation,
  SoulMemorySearchRequestSchema,
  sourceRecallTarget,
  type SoulMemorySearchRequest,
  type SoulMemorySearchResponse,
  type SourceLocatedInterpretation
} from "@do-soul/alaya-protocol";
import {
  compileQuerySourceSketch,
  toSourceRootObserverRow,
  type ConditionalFieldExecutionReceipt,
  type ObserverReaders
} from "@do-soul/alaya-core";
import {
  observeConditionalField,
  startObserverCursor
} from "../../../../../../packages/core/src/recall/conditional-field/observers/observe.js";
import {
  SqliteEvidenceCapsuleRepo,
  SqliteFieldSourceRecordRepo,
  SqliteSourceHintReader,
  SqliteSourceRootRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import type { FirstExposurePage } from
  "../../../../../../apps/bench-runner/src/runs/measurement/first-exposure-session.js";
import { fieldContractSha256 } from "../../../../../../packages/core/src/shared/field-hash.js";
import {
  canaryContentScopeCheck,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  associativeView,
  defaultBudget,
  defaultView,
  identityAssociationCap
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import { fieldSha256 } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import type { RecallUsageToolCallContext } from "../../../mcp-memory/recall/recall-usage-handlers.js";

export const PUBLIC_CONSUMPTION_PROTOCOL = Object.freeze({
  protocol_id: "public-source-consumption-v1",
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
export type Enumeration = "canonical" | "associative";
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
    readonly continuation: PublicContinuationRef | null;
    readonly payload_continuation: PublicPayloadContinuationRef | null;
  }>;
  readonly response: Readonly<{
    readonly delivery_id: string | "unavailable";
    readonly page_purpose: string | "unavailable";
    readonly chunks: readonly PublicPayloadChunk[];
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

export type NativeDiscovery = Readonly<{
  readonly first_id: string | undefined;
  readonly ids: readonly string[];
  readonly wording: string | undefined;
  readonly visits: number;
  readonly bytes: number;
  readonly work_units: number;
  readonly candidate_scans: number;
  readonly hydrated_contexts: number;
  readonly lookup_kind: string | undefined;
}>;

export function compileCanarySketch(
  canary: CanaryCase,
  lookup: LookupMode,
  view: ResultView,
  enumeration: Enumeration
) {
  return compileQuerySourceSketch({
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    interpretation_clock: INTERPRETATION_CLOCK,
    view: {
      ...(enumeration === "associative" ? associativeView() : defaultView()),
      result_kind_view: view
    },
    sketch: {
      original_query: canary.original_query,
      relation: canary.sketch,
      lookup_mode: lookup
    }
  });
}

export function publicSearchRequest(
  canary: CanaryCase,
  lookup: LookupMode,
  view: ResultView,
  enumeration: Enumeration,
  maxResults: number = PUBLIC_CONSUMPTION_PROTOCOL.max_results
): SoulMemorySearchRequest {
  const compiled = compileCanarySketch(canary, lookup, view, enumeration);
  return SoulMemorySearchRequestSchema.parse({
    query: canary.original_query,
    max_results: maxResults,
    scope_class: null,
    dimension: null,
    domain_tags: null,
    result_kind_view: view,
    enumeration_policy: enumeration,
    interpretation_proposal: compiled.interpretation_proposal,
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
  view?: ResultView
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
    if ((step.source_bodies[intendedRootId] ?? "").includes(canary.intended)) {
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
      content,
      view,
      seenOnPublic,
      resourceRejected
    })
  };
}

export function insertLocatedBoundGist(
  database: StorageDatabase,
  objectId: string,
  source: string,
  rootId: string,
  digest: string,
  evidenceObjectId: string | null,
  located: SourceLocatedInterpretation,
  workspaceId: string,
  runId: string,
  now: string
): void {
  const bound = {
    ...located,
    source_target: sourceRecallTarget({
      workspace_id: workspaceId,
      root_kind: "source_record",
      root_id: rootId,
      source_version: "v1",
      content_digest: digest,
      evidence_object_id: evidenceObjectId
    })
  };
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, created_at, updated_at, created_by, evidence_kind, semantic_anchor,
      gist, excerpt, run_id, workspace_id
    ) VALUES (?, ?, ?, 'test', 'conversation_excerpt', '{}', ?, ?, ?, ?)
  `).run(objectId, now, now, JSON.stringify(bound), source, runId, workspaceId);
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
): void {
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
  insertLocatedBoundGist(
    database, objectId, source, rootId, digest, evidenceObjectId, located, workspaceId, runId, now
  );
}

export function observePlantedDiscovery(
  database: StorageDatabase,
  workspaceId: string,
  canary: CanaryCase,
  lookup: LookupMode,
  view: ResultView,
  enumeration: Enumeration
): NativeDiscovery {
  const measurement = { candidateScans: 0, hydratedContexts: 0 };
  const query = compileCanarySketch(canary, lookup, view, enumeration);
  const observed = observeConditionalField({
    lease: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      lease_id: "lease-public-consumption",
      snapshot_id: SNAPSHOT_ID,
      query_id: query.query_id,
      status: "active"
    },
    action: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      action: "seed",
      region_id: "seed",
      work_limit: PUBLIC_CONSUMPTION_PROTOCOL.native_observer_work_limit
    },
    cursor: startObserverCursor({
      cursor_id: "seed",
      snapshot_id: SNAPSHOT_ID,
      query_id: query.query_id,
      region_id: "seed"
    }),
    query,
    workspace_id: workspaceId,
    authorized_scopes: null,
    readers: sqliteObserverReaders(database, measurement)
  });
  return {
    first_id: observed.page.observations[0]?.object_id,
    ids: observed.page.observations.map((row) => row.object_id),
    wording: observed.source_roots?.[0]?.content,
    visits: observed.work.native_visits,
    bytes: observed.work.bytes_read,
    work_units: observed.work.work_units,
    candidate_scans: measurement.candidateScans,
    hydrated_contexts: measurement.hydratedContexts,
    lookup_kind: observed.lookup_reasons?.[0]?.kind
  };
}

function sqliteObserverReaders(
  database: StorageDatabase,
  measurement: { candidateScans: number; hydratedContexts: number }
): ObserverReaders {
  const roots = new SqliteSourceRootRecallReader(
    new SqliteFieldSourceRecordRepo(database, fieldSha256),
    new SqliteEvidenceCapsuleRepo(database)
  );
  return {
    sourceRoots: (input) => {
      const page = roots.page(input);
      return { ...page, rows: page.rows.map(toSourceRootObserverRow) };
    },
    boundInterpretations: (input) => {
      const page = new SqliteSourceHintReader(database.connection).pageBoundInterpretations(input);
      measurement.candidateScans += page.nativeVisits;
      return page;
    },
    sourceTextHints: (input) => {
      const page = new SqliteSourceHintReader(database.connection).pageSourceTextHints(input);
      measurement.candidateScans += page.nativeVisits;
      return { ...page, rows: page.rows.map(toSourceRootObserverRow) };
    },
    sourceRoot: (input) => {
      measurement.hydratedContexts += 1;
      const page = roots.hydrate(input.workspaceId, sourceRecallTarget({
        workspace_id: input.workspaceId,
        root_kind: input.rootKind,
        root_id: input.rootId,
        source_version: input.revision!,
        content_digest: input.digest!,
        evidence_object_id: input.evidenceObjectId ?? null
      }), input.byteLimit, input.offset, input.nativeByteLimit);
      return { ...page, row: page.row === null ? null : toSourceRootObserverRow(page.row) };
    }
  };
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
  readonly content: ReturnType<typeof canaryContentScopeCheck>;
  readonly view: ResultView | undefined;
  readonly seenOnPublic: boolean;
  readonly resourceRejected: boolean;
}>): ConsumptionAttribution {
  if (input.content.has_full_intended) return "hit";
  if (input.view === "memory_only") return "qualification";
  if (input.resourceRejected) return "resource";
  if (!input.seenOnPublic) return "unknown";
  return "payload";
}
