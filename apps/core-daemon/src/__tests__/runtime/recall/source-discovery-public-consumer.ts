import { createHash } from "node:crypto";
import {
  ContinuationSchema,
  PayloadContinuationRequestSchema,
  SoulMemorySearchRequestSchema,
  sourceEvidenceRootTarget,
  type Continuation,
  type SoulMemorySearchRequest,
  type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import type { ConditionalFieldExecutionReceipt } from "@do-soul/alaya-core";
import { FirstExposureSession } from
  "../../../../../../apps/bench-runner/src/runs/measurement/first-exposure-session.js";
import {
  PUBLIC_CONSUMPTION_PROTOCOL,
  type CapRemainder,
  type ConsumptionStep,
  type ConsumptionStopReason,
  type ConsumptionTrace,
  type Cost,
  type PublicConsumer,
  type PublicPayloadChunk,
  type PublicPayloadContinuationRef,
  type PublicStepExchange
} from "./source-discovery-public-consumption.js";
import type { RecallUsageToolCallContext } from "../../../mcp-memory/recall/recall-usage-handlers.js";

type PendingSource = Readonly<{
  readonly root_id: string;
  readonly target: ReturnType<typeof sourceEvidenceRootTarget>;
  readonly start_offset: number;
}>;

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
  const pending: PendingSource[] = [];
  const discardedCapped = new Set<string>();
  const assemblyGaps = new Set<string>();
  const steps: ConsumptionStep[] = [];
  const base = membershipBase(input.request);
  const parsedInitial = SoulMemorySearchRequestSchema.parse(base);
  const turnCap = declaredTurnCap(parsedInitial.max_results);
  let membershipPage = 0;
  let payloadExpansions = 0;
  let visits: Cost = 0;
  let bytes: Cost = 0;
  let request = parsedInitial;
  let membershipContinuation: Continuation | null = null;
  let firstExposure: ConsumptionTrace["first_exposure"] = null;
  let firstPageIdentities: string[] = [];
  let firstPageComplete: Record<string, boolean> = {};

  for (let turn = 0; turn < turnCap; turn++) {
    const started = input.receipts.length;
    const response = await input.handler(request, input.context);
    const added = input.receipts.slice(started);
    const actual = added.at(-1)?.actual;
    visits = addCost(visits, actual?.native_visits);
    bytes = addCost(bytes, actual?.native_bytes);
    const retained = observedCost(actual?.retained_bytes_current);
    applyPublicPayloads(response, bodies, complete, assemblyGaps);
    const identities = publicIdentities(response);
    const purpose = response.page_purpose ?? response.index?.page_purpose ?? "membership";
    const payloadRequest = request.payload_continuation !== undefined;
    if (!payloadRequest && request.continuation === undefined) {
      firstExposure = session.record(response);
      firstPageIdentities = identities;
      firstPageComplete = Object.fromEntries(complete);
      membershipPage += 1;
      membershipContinuation = response.index?.continuation ?? null;
      enqueueIncomplete(pending, response, complete);
    } else if (payloadRequest) {
      payloadExpansions += 1;
      refreshPendingAfterPayload(pending, response, complete, expansionsByTarget, discardedCapped);
    } else {
      membershipPage += 1;
      session.record(response, parsedContinuation(request.continuation));
      membershipContinuation = response.index?.continuation ?? null;
      enqueueIncomplete(pending, response, complete);
    }
    const step = consumptionStep({
      purpose,
      membershipPage,
      payloadExpansions,
      visits,
      bytes,
      retained,
      identities,
      bodies,
      complete,
      response,
      public_exchange: capturePublicExchange(turn, request, response, added),
      assembly_gap: [...assemblyGaps],
      stop_reason: undefined
    });
    const invalidated = response.index?.completeness.logical_index === "invalidated";
    const next = invalidated ? undefined : nextPublicRequest({
      base,
      pending,
      expansionsByTarget,
      discardedCapped,
      membershipContinuation,
      membershipPage
    });
    const stop_reason = stopReason({
      invalidated,
      next,
      membershipPage,
      pending,
      lastTurn: turn + 1 >= turnCap
    });
    const recorded = stop_reason === undefined ? step : terminateStep(step, stop_reason, discardedCapped);
    steps.push(recorded);
    if (stop_reason !== undefined) {
      return finishTrace({
        firstExposure,
        firstPageIdentities,
        firstPageComplete,
        steps,
        termination: recorded,
        discardedCapped,
        assemblyGaps,
        expansionsByTarget
      });
    }
    if (next === undefined) {
      throw new Error("public consumption continued without a next request or stop reason");
    }
    request = next;
  }
  const overflow = steps.at(-1);
  if (overflow === undefined) {
    throw new Error("public consumption produced no steps before the declared turn cap");
  }
  const termination = terminateStep(overflow, "declared_turn_cap", discardedCapped);
  return finishTrace({
    firstExposure,
    firstPageIdentities,
    firstPageComplete,
    steps: [...steps.slice(0, -1), termination],
    termination,
    discardedCapped,
    assemblyGaps,
    expansionsByTarget
  });
}

export function publicIdentities(response: SoulMemorySearchResponse): string[] {
  return response.results.map((row) => {
    if (row.target?.kind === "source_evidence") return row.target.root_id;
    if (row.target?.kind === "memory_entry") return row.target.object_id;
    return row.object_id ?? "unknown";
  });
}

export function applyPublicPayloads(
  response: Readonly<{ readonly results: readonly Readonly<{
    readonly target?: Readonly<{ kind?: string; root_id?: string; span?: Readonly<{
      content_start?: number;
      content_complete?: boolean;
    }> }>;
    readonly content_preview: string;
  }>[] }>,
  bodies: Map<string, string>,
  complete: Map<string, boolean>,
  assemblyGaps: Set<string>
): void {
  for (const row of response.results) {
    if (row.target?.kind !== "source_evidence") continue;
    const rootId = row.target.root_id;
    if (rootId === undefined) continue;
    const preview = row.content_preview;
    const span = row.target.span;
    if (preview !== "[payload omitted]") {
      const start = span?.content_start ?? 0;
      const prior = Buffer.from(bodies.get(rootId) ?? "", "utf8");
      if (start === 0) bodies.set(rootId, preview);
      else if (start === prior.length) {
        bodies.set(rootId, Buffer.concat([prior, Buffer.from(preview, "utf8")]).toString("utf8"));
      } else {
        assemblyGaps.add(rootId);
      }
    }
    if (assemblyGaps.has(rootId)) {
      complete.set(rootId, false);
      continue;
    }
    complete.set(rootId, span?.content_complete === true && preview !== "[payload omitted]");
  }
}

function nextPublicRequest(input: Readonly<{
  readonly base: SoulMemorySearchRequest;
  readonly pending: PendingSource[];
  readonly expansionsByTarget: Map<string, number>;
  readonly discardedCapped: Set<string>;
  readonly membershipContinuation: Continuation | null;
  readonly membershipPage: number;
}>): ReturnType<typeof SoulMemorySearchRequestSchema.parse> | undefined {
  const expandable = nextExpandable(input.pending, input.expansionsByTarget, input.discardedCapped);
  if (expandable !== undefined) {
    const used = input.expansionsByTarget.get(expandable.root_id) ?? 0;
    input.expansionsByTarget.set(expandable.root_id, used + 1);
    return SoulMemorySearchRequestSchema.parse({
      ...input.base,
      continuation: input.membershipContinuation ?? undefined,
      payload_continuation: PayloadContinuationRequestSchema.parse({
        schema_version: 1,
        purpose: "payload_expansion",
        target: expandable.target,
        start_offset: expandable.start_offset,
        byte_budget: PUBLIC_CONSUMPTION_PROTOCOL.payload_byte_budget
      })
    });
  }
  if (input.membershipContinuation == null) return undefined;
  if (input.membershipPage >= PUBLIC_CONSUMPTION_PROTOCOL.max_membership_pages) return undefined;
  return SoulMemorySearchRequestSchema.parse({
    ...input.base,
    continuation: input.membershipContinuation
  });
}

function nextExpandable(
  pending: PendingSource[],
  expansionsByTarget: Map<string, number>,
  discardedCapped: Set<string>
): PendingSource | undefined {
  while (pending.length > 0) {
    const candidate = pending[0]!;
    const used = expansionsByTarget.get(candidate.root_id) ?? 0;
    if (used < PUBLIC_CONSUMPTION_PROTOCOL.max_payload_expansions_per_target) return candidate;
    pending.shift();
    discardedCapped.add(candidate.root_id);
  }
  return undefined;
}

function enqueueIncomplete(
  pending: PendingSource[],
  response: SoulMemorySearchResponse,
  complete: Map<string, boolean>
): void {
  const seen = new Set(pending.map((row) => row.root_id));
  for (const row of incompleteSources(response)) {
    if (complete.get(row.root_id) === true || seen.has(row.root_id)) continue;
    pending.push(row);
    seen.add(row.root_id);
  }
}

function refreshPendingAfterPayload(
  pending: PendingSource[],
  response: SoulMemorySearchResponse,
  complete: Map<string, boolean>,
  expansionsByTarget: Map<string, number>,
  discardedCapped: Set<string>
): void {
  const current = pending[0];
  if (current === undefined) return;
  if (complete.get(current.root_id) === true) {
    pending.shift();
    return;
  }
  const updated = incompleteSources(response).find((row) => row.root_id === current.root_id);
  if (updated === undefined) return;
  const used = expansionsByTarget.get(current.root_id) ?? 0;
  if (used >= PUBLIC_CONSUMPTION_PROTOCOL.max_payload_expansions_per_target) {
    pending.shift();
    discardedCapped.add(current.root_id);
    return;
  }
  pending[0] = updated;
}

function incompleteSources(response: SoulMemorySearchResponse): PendingSource[] {
  const rows: PendingSource[] = [];
  for (const row of response.results) {
    if (row.target?.kind !== "source_evidence") continue;
    const omitted = row.content_preview === "[payload omitted]";
    const partial = row.target.span?.content_complete === false;
    if (!omitted && !partial) continue;
    rows.push({
      root_id: row.target.root_id,
      target: sourceEvidenceRootTarget(row.target),
      start_offset: row.target.span?.content_end ?? 0
    });
  }
  return rows;
}

function stopReason(input: Readonly<{
  readonly invalidated: boolean;
  readonly next: unknown;
  readonly membershipPage: number;
  readonly pending: readonly PendingSource[];
  readonly lastTurn: boolean;
}>): ConsumptionStopReason | undefined {
  if (input.invalidated) return "index_invalidated";
  if (input.next !== undefined) return input.lastTurn ? "declared_turn_cap" : undefined;
  if (input.membershipPage >= PUBLIC_CONSUMPTION_PROTOCOL.max_membership_pages
    && input.pending.length === 0) {
    return "membership_page_cap";
  }
  return "continuation_exhausted";
}

function consumptionStep(input: Readonly<{
  readonly purpose: string;
  readonly membershipPage: number;
  readonly payloadExpansions: number;
  readonly visits: Cost;
  readonly bytes: Cost;
  readonly retained: Cost;
  readonly identities: readonly string[];
  readonly bodies: Map<string, string>;
  readonly complete: Map<string, boolean>;
  readonly response: SoulMemorySearchResponse;
  readonly public_exchange: PublicStepExchange;
  readonly assembly_gap: readonly string[];
  readonly stop_reason: ConsumptionStopReason | undefined;
}>): ConsumptionStep {
  return {
    purpose: input.purpose,
    membership_page: input.membershipPage,
    payload_expansions: input.payloadExpansions,
    cumulative_native_visits: input.visits,
    cumulative_native_bytes: input.bytes,
    retained_bytes_current: input.retained,
    public_identities: input.identities,
    source_bodies: Object.fromEntries(input.bodies),
    preview_complete: Object.fromEntries(input.complete),
    logical_index: input.response.index?.completeness.logical_index,
    payload_completeness: input.response.index?.completeness.payload,
    public_exchange: input.public_exchange,
    assembly_gap: input.assembly_gap,
    ...(input.stop_reason === undefined ? {} : { stop_reason: input.stop_reason })
  };
}

function terminateStep(
  step: ConsumptionStep,
  stop_reason: ConsumptionStopReason,
  discardedCapped: ReadonlySet<string>
): ConsumptionStep {
  const discarded = [...discardedCapped];
  return {
    ...step,
    stop_reason,
    discarded_capped_incomplete_root_ids: discarded,
    cap_remainder: capRemainder(discarded)
  };
}

function finishTrace(input: Readonly<{
  readonly firstExposure: ConsumptionTrace["first_exposure"];
  readonly firstPageIdentities: readonly string[];
  readonly firstPageComplete: Readonly<Record<string, boolean>>;
  readonly steps: readonly ConsumptionStep[];
  readonly termination: ConsumptionStep;
  readonly discardedCapped: ReadonlySet<string>;
  readonly assemblyGaps: ReadonlySet<string>;
  readonly expansionsByTarget: ReadonlyMap<string, number>;
}>): ConsumptionTrace {
  const discarded = [...input.discardedCapped];
  return {
    first_exposure: input.firstExposure,
    first_page_identities: input.firstPageIdentities,
    first_page_preview_complete: input.firstPageComplete,
    steps: input.steps,
    termination: input.termination,
    discarded_capped_incomplete_root_ids: discarded,
    cap_remainder: capRemainder(discarded),
    assembly_gap: [...input.assemblyGaps],
    expansions_by_target: Object.fromEntries(input.expansionsByTarget)
  };
}

function capRemainder(discarded: readonly string[]): CapRemainder {
  return discarded.length > 0 ? "unread_after_cap" : "none";
}

function capturePublicExchange(
  stepIndex: number,
  request: SoulMemorySearchRequest,
  response: SoulMemorySearchResponse,
  added: readonly ConditionalFieldExecutionReceipt[]
): PublicStepExchange {
  const receipt = added.at(-1);
  return {
    step_index: stepIndex,
    request: {
      continuation: continuationRef(request.continuation),
      payload_continuation: payloadContinuationRef(request.payload_continuation)
    },
    response: {
      delivery_id: response.delivery_id ?? "unavailable",
      page_purpose: response.page_purpose ?? response.index?.page_purpose ?? "unavailable",
      chunks: responseChunks(response)
    },
    receipt: receipt === undefined ? "unavailable" : {
      query_id: receipt.query_id,
      interpretation_id: receipt.interpretation_id,
      snapshot_id: receipt.snapshot_id,
      actual: receipt.actual === undefined ? "unavailable" : {
        native_visits: observedCost(receipt.actual.native_visits),
        native_bytes: observedCost(receipt.actual.native_bytes),
        retained_bytes_current: observedCost(receipt.actual.retained_bytes_current)
      }
    }
  };
}

function continuationRef(
  continuation: SoulMemorySearchRequest["continuation"]
): PublicStepExchange["request"]["continuation"] {
  if (continuation === undefined || continuation === null) return null;
  return {
    continuation_id: continuation.continuation_id,
    query_id: continuation.query_id,
    snapshot_id: continuation.snapshot_id,
    cursor: continuation.cursor
  };
}

function payloadContinuationRef(
  payload: SoulMemorySearchRequest["payload_continuation"]
): PublicPayloadContinuationRef | null {
  if (payload === undefined) return null;
  const target = payload.target;
  return {
    target_kind: target.kind,
    root_id: target.kind === "source_evidence" ? target.root_id : "unavailable",
    source_version: target.kind === "source_evidence" ? target.source_version : "unavailable",
    content_digest: target.kind === "source_evidence" ? target.content_digest : "unavailable",
    start_offset: payload.start_offset ?? "unavailable",
    byte_budget: payload.byte_budget ?? "unavailable"
  };
}

function responseChunks(response: SoulMemorySearchResponse): PublicPayloadChunk[] {
  const chunks: PublicPayloadChunk[] = [];
  for (const row of response.results) {
    if (row.target?.kind !== "source_evidence") continue;
    const span = row.target.span;
    const omitted = row.content_preview === "[payload omitted]";
    chunks.push({
      root_id: row.target.root_id,
      source_version: row.target.source_version,
      content_digest: row.target.content_digest,
      content_start: span?.content_start ?? "unavailable",
      content_end: span?.content_end ?? "unavailable",
      content_complete: span?.content_complete ?? "unavailable",
      retained_extent: span?.retained_extent ?? "unavailable",
      preview_omitted: omitted,
      chunk_utf8_bytes: omitted ? "unavailable" : Buffer.byteLength(row.content_preview, "utf8"),
      chunk_sha256: omitted ? "unavailable" : createHash("sha256").update(row.content_preview, "utf8").digest("hex"),
      chunk_text: omitted ? "unavailable" : row.content_preview
    });
  }
  return chunks;
}

function membershipBase(request: SoulMemorySearchRequest): SoulMemorySearchRequest {
  const { continuation: _continuation, payload_continuation: _payload, ...rest } = request;
  return rest;
}

function parsedContinuation(value: SoulMemorySearchRequest["continuation"]): Continuation | null {
  if (value === undefined || value === null) return null;
  return ContinuationSchema.parse(value);
}

function declaredTurnCap(maxResults: number): number {
  return PUBLIC_CONSUMPTION_PROTOCOL.max_membership_pages
    * (1 + maxResults * PUBLIC_CONSUMPTION_PROTOCOL.max_payload_expansions_per_target);
}

function observedCost(value: number | undefined): Cost {
  if (typeof value !== "number") return "unavailable";
  return value;
}

function addCost(current: Cost, delta: number | undefined): Cost {
  if (current === "unavailable" || typeof delta !== "number") return "unavailable";
  return current + delta;
}
