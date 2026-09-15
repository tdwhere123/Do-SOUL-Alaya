import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  locateSourceInterpretation,
  sourceEvidenceRootTarget,
  sourceRecallTarget,
  type SoulMemorySearchRequest,
  type SoulMemorySearchResponse
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
import { FirstExposureSession, type FirstExposurePage } from
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
  max_results: 8,
  historical_max_results: 1,
  payload_byte_budget: 4096,
  max_membership_pages: 16,
  max_payload_expansions_per_target: 16,
  native_observer_work_limit: 7,
  request_work_units: 10_000,
  request_memory_bytes: 1_000_000
});

export type LookupMode = "proposal" | "source_text";
export type ResultView = "source_only" | "mixed" | "memory_only";
export type Enumeration = "canonical" | "associative";
export type Cost = number | "unavailable";

export type PublicConsumer = (
  request: SoulMemorySearchRequest,
  context: RecallUsageToolCallContext
) => Promise<SoulMemorySearchResponse>;

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
}>;

export type ConsumptionTrace = Readonly<{
  readonly first_exposure: FirstExposurePage | null;
  readonly first_page_identities: readonly string[];
  readonly first_page_preview_complete: Readonly<Record<string, boolean>>;
  readonly steps: readonly ConsumptionStep[];
  readonly termination: ConsumptionStep;
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
  maxResults = PUBLIC_CONSUMPTION_PROTOCOL.max_results
): SoulMemorySearchRequest {
  const compiled = compileCanarySketch(canary, lookup, view, enumeration);
  return {
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
  };
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

export async function consumePublicSources(input: Readonly<{
  readonly handler: PublicConsumer;
  readonly context: RecallUsageToolCallContext;
  readonly request: SoulMemorySearchRequest;
  readonly receipts: ConditionalFieldExecutionReceipt[];
}>): Promise<ConsumptionTrace> {
  const session = new FirstExposureSession();
  const bodies = new Map<string, string>();
  const complete = new Map<string, boolean>();
  const expansionsByTarget = new Map<string, number>();
  const steps: ConsumptionStep[] = [];
  let membershipPage = 0;
  let payloadExpansions = 0;
  let visits: Cost = 0;
  let bytes: Cost = 0;
  let request: SoulMemorySearchRequest = input.request;
  let firstExposure: FirstExposurePage | null = null;
  let firstPageIdentities: string[] = [];
  let firstPageComplete: Record<string, boolean> = {};

  for (let turn = 0; turn < PUBLIC_CONSUMPTION_PROTOCOL.max_membership_pages * 4; turn++) {
    const started = input.receipts.length;
    const response = await input.handler(request, input.context);
    const added = input.receipts.slice(started);
    visits = addCost(visits, added.at(-1)?.actual?.native_visits);
    bytes = addCost(bytes, added.at(-1)?.actual?.native_bytes);
    const retained = added.at(-1)?.actual?.retained_bytes_current ?? "unavailable";
    applyPublicPayloads(response, bodies, complete);
    const identities = publicIdentities(response);
    const purpose = response.page_purpose ?? response.index?.page_purpose ?? "membership";
    if (request.payload_continuation === undefined && request.continuation === undefined) {
      firstExposure = session.record(response);
      firstPageIdentities = identities;
      firstPageComplete = Object.fromEntries(complete);
      membershipPage += 1;
    } else if (request.payload_continuation !== undefined) {
      payloadExpansions += 1;
    } else {
      membershipPage += 1;
      session.record(response, request.continuation ?? null);
    }
    const step = {
      purpose,
      membership_page: membershipPage,
      payload_expansions: payloadExpansions,
      cumulative_native_visits: visits,
      cumulative_native_bytes: bytes,
      retained_bytes_current: retained,
      public_identities: identities,
      source_bodies: Object.fromEntries(bodies),
      preview_complete: Object.fromEntries(complete),
      logical_index: response.index?.completeness.logical_index,
      payload_completeness: response.index?.completeness.payload
    };
    steps.push(step);
    const next = nextPublicRequest(input.request, request, response, expansionsByTarget);
    const done = next === undefined
      || (membershipPage >= PUBLIC_CONSUMPTION_PROTOCOL.max_membership_pages
        && next.payload_continuation === undefined);
    if (done) {
      return {
        first_exposure: firstExposure,
        first_page_identities: firstPageIdentities,
        first_page_preview_complete: firstPageComplete,
        steps,
        termination: step
      };
    }
    request = next!;
  }
  throw new Error("public consumption exceeded the declared turn cap");
}

export function scoreConsumption(
  canary: CanaryCase,
  intendedRootId: string,
  trace: ConsumptionTrace,
  native?: NativeDiscovery,
  view?: ResultView
): Readonly<{
  readonly first_page_includes_intended: boolean;
  readonly first_page_position: number | null;
  readonly first_complete_step: number | null;
  readonly primary_native_visits: Cost | "miss";
  readonly content: ReturnType<typeof canaryContentScopeCheck>;
  readonly attribution: string;
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
  const seenLater = trace.steps.some((step) => step.public_identities.includes(intendedRootId)
    || Object.keys(step.source_bodies).includes(intendedRootId));
  const discovered = native?.ids.includes(intendedRootId) === true;
  let attribution = "unknown";
  if (content.has_full_intended) attribution = "hit";
  else if (view === "memory_only") attribution = "qualification";
  else if (!discovered && !seenLater) attribution = "discovery";
  else if (!seenLater) attribution = "qualification";
  else if (!firstPageIncludes) attribution = "order";
  else if (trace.termination.payload_completeness === "resource_rejected"
    || trace.termination.logical_index === "resource_rejected") attribution = "resource";
  else attribution = "payload";
  return {
    first_page_includes_intended: firstPageIncludes,
    first_page_position: firstPageIncludes ? firstPosition + 1 : null,
    first_complete_step: firstComplete,
    primary_native_visits: firstComplete === null
      ? "miss"
      : trace.steps[firstComplete]!.cumulative_native_visits,
    content,
    attribution
  };
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

function publicIdentities(response: SoulMemorySearchResponse): string[] {
  return response.results.map((row) => {
    if (row.target?.kind === "source_evidence") return row.target.root_id;
    if (row.target?.kind === "memory_entry") return row.target.object_id;
    return row.object_id ?? "unknown";
  });
}

function applyPublicPayloads(
  response: SoulMemorySearchResponse,
  bodies: Map<string, string>,
  complete: Map<string, boolean>
): void {
  for (const row of response.results) {
    if (row.target?.kind !== "source_evidence") continue;
    const rootId = row.target.root_id;
    const preview = row.content_preview;
    const span = row.target.span;
    if (preview !== "[payload omitted]") {
      const start = span?.content_start ?? 0;
      const prior = Buffer.from(bodies.get(rootId) ?? "", "utf8");
      if (start === 0) bodies.set(rootId, preview);
      else if (start === prior.length) {
        bodies.set(rootId, Buffer.concat([prior, Buffer.from(preview, "utf8")]).toString("utf8"));
      }
    }
    complete.set(rootId, span?.content_complete === true && preview !== "[payload omitted]");
  }
}

function nextPublicRequest(
  base: SoulMemorySearchRequest,
  current: SoulMemorySearchRequest,
  response: SoulMemorySearchResponse,
  expansionsByTarget: Map<string, number>
): SoulMemorySearchRequest | undefined {
  if (response.index?.completeness.logical_index === "invalidated") return undefined;
  const incomplete = response.results.find((row) => {
    if (row.target?.kind !== "source_evidence") return false;
    if (row.content_preview === "[payload omitted]") return true;
    return row.target.span?.content_complete === false;
  });
  if (incomplete?.target?.kind === "source_evidence") {
    const key = incomplete.target.root_id;
    const used = expansionsByTarget.get(key) ?? 0;
    if (used < PUBLIC_CONSUMPTION_PROTOCOL.max_payload_expansions_per_target) {
      expansionsByTarget.set(key, used + 1);
      const start = incomplete.target.span?.content_end ?? 0;
      return {
        ...base,
        continuation: response.index?.continuation ?? current.continuation,
        payload_continuation: {
          schema_version: 1,
          purpose: "payload_expansion",
          target: sourceEvidenceRootTarget(incomplete.target),
          start_offset: start,
          byte_budget: PUBLIC_CONSUMPTION_PROTOCOL.payload_byte_budget
        }
      };
    }
  }
  if (response.index?.continuation == null) return undefined;
  return { ...base, continuation: response.index.continuation };
}

function addCost(current: Cost, delta: number | undefined): Cost {
  if (current === "unavailable" || delta === undefined) return "unavailable";
  return current + delta;
}
