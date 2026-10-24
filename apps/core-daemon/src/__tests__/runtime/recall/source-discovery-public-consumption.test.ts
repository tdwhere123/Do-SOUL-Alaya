import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { sourceDisclosure, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { WS, RUN, NOW } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  SOURCE_DISCOVERY_CANARY,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import {
  LIVE_ORDINARY_ENUMERATION,
  LIVE_ORDINARY_ENUMERATIONS,
  PUBLIC_CONSUMPTION_PROTOCOL,
  compileCanarySketch,
  observePlantedDiscovery,
  publicSearchRequest,
  scoreConsumption,
  type ConsumptionTrace,
  type Enumeration,
  type LookupMode,
  type ResultView
} from "./source-discovery-public-consumption.js";
import {
  boundTrace,
  caseKey,
  persistRunEvidence,
  reconstructedSourceBodies,
  type CaseIdentity
} from "./source-discovery-public-consumption-evidence.js";
import {
  awaitWorkerAfterMainSqliteClose,
  withOmittedPairWorker,
  withPlantedWorker,
  withPublicOrderedPairWorker
} from "./source-discovery-public-consumption-plant.js";

const COMPLETE_SOURCE_MARKER = "COMPLETE_SOURCE_MARKER";
const TRAILING_SOURCE_MARKER = "TRAILING_SOURCE_MARKER";
const CAPPED_SOURCE_MARKER = "CAPPED_SOURCE_MARKER";

const rows: unknown[] = [];
const traces: unknown[] = [];
const completedCases: CaseIdentity[] = [];
const inflightCases: CaseIdentity[] = [];
let failedCases: CaseIdentity[] | "unavailable" = "unavailable";

afterEach((context) => {
  if (context.task.result?.state !== "fail") return;
  for (const identity of inflightCases) noteFailedCase(identity);
});

// Vitest 4 suite hooks require object destructuring as the first argument.
afterAll(({}, suite) => {
  persistRunEvidence({
    rows,
    traces,
    selected: selectedPublicConsumptionCases(),
    completed: completedCases,
    failed: failedCases,
    fileFailed: observedVitestFailure(suite),
    evidenceDirectory: process.env.ALAYA_ADMISSION_EVIDENCE_DIRECTORY,
    provenance: "authored-cap-and-order-companion"
  });
});

describe("public source consumption comparison", () => {
  assertBuiltWorker();

  it.each(SOURCE_DISCOVERY_CANARY.flatMap((canary) => (
    ["source_only", "mixed"] as const
  ).map((view) => ({ canary, view }))))(
    "$canary.group $view distractor-first equal-budget public pair",
    async ({ canary, view }) => {
      await withPlantedWorker(canary, view, false, async (planted, handler, receipts, client) => {
        const native = {
          proposal: observePlantedDiscovery(planted.database, WS, canary, "proposal", view, LIVE_ORDINARY_ENUMERATION),
          source_text: observePlantedDiscovery(planted.database, WS, canary, "source_text", view, LIVE_ORDINARY_ENUMERATION)
        };
        planted.database.close();
        closeCachedDatabase(planted.filename);
        await awaitWorkerAfterMainSqliteClose(client);
        for (const enumeration of LIVE_ORDINARY_ENUMERATIONS) {
          const pair: Awaited<ReturnType<typeof runPair>>[] = [];
          for (const lookup of ["proposal", "source_text"] as const) {
            pair.push(await attemptCell({
              cell: "primary", group: canary.group, view, enumeration, lookup
            }, async () => {
              const run = await runPair({
                canary, view, enumeration, lookup, intendedId: planted.intendedId,
                handler, receipts, native: native[lookup], maxResults: PUBLIC_CONSUMPTION_PROTOCOL.max_results,
                cell: "primary"
              });
              assertSettledConsumption(run.row);
              return run;
            }));
          }
          commitPairedCells(pair);
        }
        if (view === "source_only") {
          for (const lookup of ["proposal", "source_text"] as const) {
            const run = await attemptCell({
              cell: "historical_page1", group: canary.group, view, enumeration: LIVE_ORDINARY_ENUMERATION, lookup
            }, async () => {
              const result = await runPair({
                canary, view, enumeration: LIVE_ORDINARY_ENUMERATION, lookup, intendedId: planted.intendedId,
                handler, receipts, maxResults: PUBLIC_CONSUMPTION_PROTOCOL.historical_max_results,
                cell: "historical_page1"
              });
              assertSettledConsumption(result.row);
              return result;
            });
            commitCell(run);
          }
        }
      });
    },
    90_000
  );

  it.each(SOURCE_DISCOVERY_CANARY.flatMap((canary) => (
    ["source_only", "mixed"] as const
  ).map((view) => ({ canary, view }))))(
    "$canary.group $view intended-first supplemental public pair",
    async ({ canary, view }) => {
      await withPlantedWorker(canary, view, true, async (planted, handler, receipts, client) => {
        planted.database.close();
        closeCachedDatabase(planted.filename);
        await awaitWorkerAfterMainSqliteClose(client);
        for (const enumeration of LIVE_ORDINARY_ENUMERATIONS) {
          const pair: Awaited<ReturnType<typeof runPair>>[] = [];
          for (const lookup of ["proposal", "source_text"] as const) {
            pair.push(await attemptCell({
              cell: "supplemental_intended_first", group: canary.group, view, enumeration, lookup
            }, async () => {
              const run = await runPair({
                canary, view, enumeration, lookup, intendedId: planted.intendedId,
                handler, receipts, maxResults: PUBLIC_CONSUMPTION_PROTOCOL.max_results,
                cell: "supplemental_intended_first"
              });
              assertSettledConsumption(run.row);
              return run;
            }));
          }
          commitPairedCells(pair);
        }
      });
    },
    90_000
  );

  it("memory_only omits sources for both lookups", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    await withPlantedWorker(canary, "memory_only", false, async (planted, handler, receipts, client) => {
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await awaitWorkerAfterMainSqliteClose(client);
      for (const lookup of ["proposal", "source_text"] as const) {
        const scored = await attemptCell({
          cell: "memory_only", group: canary.group, view: "memory_only",
          enumeration: LIVE_ORDINARY_ENUMERATION, lookup
        }, async () => {
          const run = await runPair({
            canary, view: "memory_only", enumeration: LIVE_ORDINARY_ENUMERATION, lookup,
            intendedId: planted.intendedId, handler, receipts, maxResults: PUBLIC_CONSUMPTION_PROTOCOL.max_results,
            cell: "memory_only"
          });
          expect(run.row.public_source_identities).toEqual([]);
          expect(run.row.score.content.has_full_intended).toBe(false);
          expect(run.row.score.consumption_attribution).toBe("qualification");
          expect(run.row.score.first_page_omission).toBe(true);
          expect(run.row.score.first_page_omission_attribution).toBe("absent");
          return run;
        });
        commitCell(scored);
      }
    });
  }, 90_000);

  it("keeps lookup mode as the only compiled interpretation difference in a pair", () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const proposal = compileCanarySketch(canary, "proposal", "source_only", LIVE_ORDINARY_ENUMERATION);
    const text = compileCanarySketch(canary, "source_text", "source_only", LIVE_ORDINARY_ENUMERATION);
    expect(proposal.query_id).not.toBe(text.query_id);
    expect(proposal.interpretation_proposal?.original_query_digest)
      .toBe(text.interpretation_proposal?.original_query_digest);
  });

  it("completes the first public SourceRecord then reads a later omitted record alongside standalone capsules", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const firstBody = `${COMPLETE_SOURCE_MARKER} ${canary.intended} ${"y".repeat(8_000)}`;
    const secondBody = `${TRAILING_SOURCE_MARKER} ${canary.intended} ${"z".repeat(9_000)}`;
    await withOmittedPairWorker(canary, firstBody, secondBody, async (planted, handler, receipts, client) => {
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await awaitWorkerAfterMainSqliteClose(client);
      const identity: CaseIdentity = {
        cell: "public_first_complete_then_later_read", group: canary.group,
        view: "source_only", enumeration: LIVE_ORDINARY_ENUMERATION, lookup: "proposal"
      };
      const consumed = await attemptCell(identity, async () => {
        const result = await consumePairTrace(canary, handler, receipts);
        const { publicFirst, laterId } = assertOmittedPairExposure(
          result, [planted.first_id, planted.second_id], planted.gistObjectIds, canary.intended
        );
        const bodyById: Record<string, string> = {
          [planted.first_id]: planted.first_body,
          [planted.second_id]: planted.second_body
        };
        expect(result.trace.termination.preview_complete[publicFirst!]).toBe(true);
        expect(result.trace.termination.source_bodies[publicFirst!]).toBe(bodyById[publicFirst!]);
        const fullScore = scoreConsumption(canary, publicFirst!, result.trace, "source_only", bodyById[publicFirst!]);
        const firstContext = result.trace.steps.findIndex((step) =>
          (step.source_bodies[publicFirst!] ?? "").includes(canary.intended));
        expect(fullScore.first_complete_step).toBeGreaterThan(firstContext);
        expect(result.trace.steps[fullScore.first_complete_step!]!.preview_complete[publicFirst!]).toBe(true);
        expect((result.trace.termination.source_bodies[laterId!] ?? "").length).toBeGreaterThan(0);
        expect(payloadStepsFor(result.trace, laterId!).length).toBeGreaterThan(0);
        expect(payloadStepsFor(result.trace, laterId!)[0]!.public_exchange.step_index)
          .toBeGreaterThan(fullScore.first_complete_step!);
        expect(result.settled).toHaveLength(result.trace.steps.length);
        expect(result.trace.termination.stop_reason).toMatch(/continuation_exhausted|membership_page_cap|index_invalidated|declared_turn_cap/);
        assertAssembledMatchesReconstruction(result.trace);
        return result;
      });
      recordTrace(identity, canary, consumed.trace, consumed.settled);
    });
  }, 90_000);

  it("caps the first public SourceRecord then fully consumes a later record without conflating capsule excerpts", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const publicFirstBody = cappedSourceBody(canary);
    const laterBody = completeSourceBody(canary);
    await withPublicOrderedPairWorker(canary, publicFirstBody, laterBody, async (planted, handler, receipts) => {
      const identity: CaseIdentity = {
        cell: "public_first_capped_then_later_complete", group: canary.group,
        view: "source_only", enumeration: LIVE_ORDINARY_ENUMERATION, lookup: "proposal"
      };
      const consumed = await attemptCell(identity, async () => {
        const result = await consumePairTrace(canary, handler, receipts);
        const { publicFirst, laterId } = assertOmittedPairExposure(
          result, [planted.public_first_id, planted.later_id], planted.gistObjectIds, canary.intended
        );
        expect(publicFirst).toBe(planted.public_first_id);
        expect(laterId).toBe(planted.later_id);
        const cap = PUBLIC_CONSUMPTION_PROTOCOL.max_payload_expansions_per_target;
        const firstPayload = payloadStepsFor(result.trace, publicFirst!);
        expect(firstPayload).toHaveLength(cap);
        expect(firstPayload.every((step) => step.preview_complete[publicFirst!] !== true)).toBe(true);
        expect(result.trace.termination.preview_complete[publicFirst!]).toBe(false);
        expect(result.trace.termination.source_bodies[publicFirst!] ?? "").toContain(CAPPED_SOURCE_MARKER);
        expect(result.trace.termination.source_bodies[publicFirst!] ?? "").not.toBe(publicFirstBody);
        expect(result.trace.steps.some((step) => (step.source_bodies[publicFirst!] ?? "").includes(canary.intended))).toBe(true);
        const cappedScore = scoreConsumption(canary, publicFirst!, result.trace, "source_only", publicFirstBody);
        expect(cappedScore.first_complete_step).toBeNull();
        expect(cappedScore.primary_native_visits).toBe("miss");
        expect(cappedScore.consumption_attribution).toBe("payload");
        expect(result.trace.termination.preview_complete[laterId!]).toBe(true);
        expect(result.trace.termination.source_bodies[laterId!] ?? "").toContain(COMPLETE_SOURCE_MARKER);
        expect(result.trace.termination.source_bodies[laterId!]).toBe(planted.later_body);
        expect(payloadStepsFor(result.trace, laterId!)[0]!.public_exchange.step_index)
          .toBeGreaterThan(firstPayload.at(-1)!.public_exchange.step_index);
        expect(result.trace.discarded_capped_incomplete_root_ids).toEqual([publicFirst]);
        expect(result.trace.cap_remainder).toBe("unread_after_cap");
        expect(result.trace.termination.discarded_capped_incomplete_root_ids).toEqual([publicFirst]);
        expect(result.trace.termination.stop_reason).toMatch(/continuation_exhausted|membership_page_cap|index_invalidated|declared_turn_cap/);
        expect(result.settled).toHaveLength(result.trace.steps.length);
        assertAssembledMatchesReconstruction(result.trace);
        return result;
      });
      recordTrace(identity, canary, consumed.trace, consumed.settled);
    });
  }, 90_000);
});

async function runPair(input: Readonly<{
  readonly canary: CanaryCase;
  readonly view: ResultView;
  readonly enumeration: Enumeration;
  readonly lookup: LookupMode;
  readonly intendedId: string;
  readonly handler: ReturnType<typeof createRecallHandler>;
  readonly receipts: import("@do-soul/alaya-core").ConditionalFieldExecutionReceipt[];
  readonly native?: ReturnType<typeof observePlantedDiscovery>;
  readonly maxResults: number;
  readonly cell: string;
}>) {
  const request = publicSearchRequest(input.canary, input.lookup, input.view, input.enumeration, input.maxResults);
  expect(request.enumeration_policy).toBe(LIVE_ORDINARY_ENUMERATION);
  const started = input.receipts.length;
  const trace = await consumePublicSources({
    handler: input.handler,
    context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
    request,
    receipts: input.receipts
  });
  expect(trace.first_exposure?.initial).not.toBeNull();
  expect(trace.first_exposure?.page_purpose === "membership"
    || trace.first_exposure?.page_purpose === "retry").toBe(true);
  expect(trace.first_exposure?.commitment).toMatch(/^[a-f0-9]{64}$/);
  const score = scoreConsumption(input.canary, input.intendedId, trace, input.view);
  const publicSourceIdentities = [...new Set(trace.steps.flatMap((step) =>
    Object.keys(step.source_bodies)))];
  const settled = input.receipts.slice(started);
  const identity: CaseIdentity = {
    cell: input.cell,
    group: input.canary.group,
    view: input.view,
    enumeration: input.enumeration,
    lookup: input.lookup
  };
  return {
    identity,
    canary: input.canary,
    trace,
    settled,
    row: {
      cell: input.cell,
      group: input.canary.group,
      view: input.view,
      enumeration: input.enumeration,
      lookup: input.lookup,
      max_results: input.maxResults,
      intended_id: input.intendedId,
      native: input.native ?? null,
      first_page_identities: trace.first_page_identities,
      first_page_preview_complete: trace.first_page_preview_complete,
      first_exposure_delivery: trace.first_exposure?.delivery_id ?? null,
      first_exposure_commitment: trace.first_exposure?.commitment ?? null,
      first_exposure_identity: trace.first_exposure?.initial?.identity ?? null,
      first_exposure_digest: trace.first_exposure?.initial?.digest ?? null,
      termination: {
        purpose: trace.termination.purpose,
        membership_page: trace.termination.membership_page,
        payload_expansions: trace.termination.payload_expansions,
        cumulative_native_visits: trace.termination.cumulative_native_visits,
        cumulative_native_bytes: trace.termination.cumulative_native_bytes,
        retained_bytes_current: trace.termination.retained_bytes_current,
        logical_index: trace.termination.logical_index,
        payload_completeness: trace.termination.payload_completeness,
        stop_reason: trace.termination.stop_reason ?? null
      },
      public_source_identities: publicSourceIdentities,
      score
    }
  };
}

function assertSettledConsumption(row: Awaited<ReturnType<typeof runPair>>["row"]): void {
  expect(row.score.first_page_omission).toBe(!row.score.first_page_includes_intended);
  if (row.score.first_page_includes_intended) {
    expect(row.score.first_page_omission_attribution).toBe("included");
  }
  if (row.score.first_complete_step !== null) {
    expect(row.score.content.has_full_intended).toBe(true);
    expect(row.score.content.has_all_required_phrases).toBe(true);
    expect(row.score.content.has_forbidden_distractor).toBe(false);
    expect(row.public_source_identities).toContain(row.intended_id);
    expect(row.score.first_complete_costs).not.toBeNull();
  }
}

function assertPairedControls(pair: readonly Awaited<ReturnType<typeof runPair>>["row"][]): void {
  expect(pair).toHaveLength(2);
  expect(pair[0]!.lookup).toBe("proposal");
  expect(pair[1]!.lookup).toBe("source_text");
  expect(pair[0]!.intended_id).toBe(pair[1]!.intended_id);
  expect(pair[0]!.view).toBe(pair[1]!.view);
  expect(pair[0]!.enumeration).toBe(pair[1]!.enumeration);
  expect(pair[0]!.max_results).toBe(pair[1]!.max_results);
  expect(pair[0]!.cell).toBe(pair[1]!.cell);
}

async function consumePairTrace(
  canary: CanaryCase,
  handler: ReturnType<typeof createRecallHandler>,
  receipts: import("@do-soul/alaya-core").ConditionalFieldExecutionReceipt[]
): Promise<Readonly<{
  readonly trace: ConsumptionTrace;
  readonly settled: import("@do-soul/alaya-core").ConditionalFieldExecutionReceipt[];
  readonly initial: SoulMemorySearchResponse;
}>> {
  const started = receipts.length;
  let initial: SoulMemorySearchResponse | undefined;
  const trace = await consumePublicSources({
    handler: async (request, context) => {
      const response = await handler(request, context);
      initial ??= response;
      for (const row of response.results) {
        if (row.target.kind === "source_evidence") {
          expect(sourceDisclosure(row.source_disclosure!)).toMatchObject({ evaluated_as_of: response.index?.as_of });
        }
      }
      return response;
    },
    context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
    request: publicSearchRequest(canary, "proposal", "source_only", LIVE_ORDINARY_ENUMERATION),
    receipts
  });
  expect(trace.steps[0]?.public_exchange.request.continuation).toBeNull();
  expect(initial).toBeDefined();
  return { trace, settled: receipts.slice(started), initial: initial! };
}

function assertOmittedPairExposure(
  result: Awaited<ReturnType<typeof consumePairTrace>>, expectedRoots: readonly string[],
  capsuleIds: readonly string[], capsuleExcerpt: string
): Readonly<{ publicFirst: string; laterId: string }> {
  const firstIndexRoots = result.initial.index?.entries.flatMap((entry) =>
    entry.target.kind === "source_evidence" ? [entry.target.root_id] : []) ?? [];
  const seen = publicPairIdentityOrder(result);
  const firstPageRecords = result.initial.results.flatMap((row) =>
    row.target.kind === "source_evidence" && row.target.root_kind === "source_record"
      ? [row.target.root_id] : []);
  const publicFirst = firstPageRecords[0];
  const laterId = seen.find((id) => expectedRoots.includes(id) && id !== publicFirst);
  if (publicFirst === undefined || laterId === undefined
    || !expectedRoots.includes(publicFirst) || !expectedRoots.includes(laterId)
    || expectedRoots.some((id) => !seen.includes(id))) {
    throw new Error(`omitted-pair public source membership ${JSON.stringify({
      publicFirst: publicFirst ?? null,
      laterId: laterId ?? null,
      seen,
      expectedRoots,
      first_index_roots: firstIndexRoots,
      page_purpose: result.initial.page_purpose ?? result.initial.index?.page_purpose ?? null,
      completeness: result.initial.index?.completeness ?? null,
      continuation: continuationDiagnostic(result.initial.index?.continuation),
      first_page_identities: result.trace.first_page_identities,
      stop_reason: result.trace.termination.stop_reason ?? null,
      membership_page: result.trace.termination.membership_page,
      payload_expansions: result.trace.termination.payload_expansions,
      steps: result.trace.steps.map((step) => ({
        step_index: step.public_exchange.step_index,
        purpose: step.purpose,
        membership_page: step.membership_page,
        identities: step.public_identities,
        continuation: continuationDiagnostic(step.public_exchange.request.continuation),
        payload_root: step.public_exchange.request.payload_continuation?.root_id ?? null,
        payload_start: step.public_exchange.request.payload_continuation?.start_offset ?? null,
        preview_complete: step.preview_complete
      }))
    })}`);
  }
  expect(new Set(seen)).toEqual(new Set([...expectedRoots, ...capsuleIds]));
  expect(firstPageRecords).toEqual([publicFirst]);
  expect(new Set(result.trace.first_page_identities)).toEqual(new Set([publicFirst, ...capsuleIds]));
  expect(result.trace.first_exposure?.initial?.slots.map((slot) =>
    slot.target.kind === "source_evidence" ? slot.target.root_id : slot.target.object_id))
    .toEqual(result.trace.first_page_identities);
  assertStandaloneCapsuleExposure(result, capsuleIds, capsuleExcerpt);
  expect(result.trace.steps[0]!.source_bodies[laterId]).toBeUndefined();
  if (!firstIndexRoots.includes(laterId)) {
    expect(result.initial.index?.continuation).not.toBeNull();
    expect(result.trace.steps.some((step) => step.public_exchange.request.continuation !== null
      && step.public_exchange.request.payload_continuation === null
      && (step.public_identities.includes(laterId)
        || Object.hasOwn(step.source_bodies, laterId)))).toBe(true);
  }
  const laterPayload = payloadStepsFor(result.trace, laterId);
  if (laterPayload.length > 0) {
    const start = laterPayload[0]!.public_exchange.request.payload_continuation?.start_offset;
    expect(typeof start === "number" && start >= 0).toBe(true);
    const priorBody = result.trace.steps.some((step) =>
      step.public_exchange.step_index < laterPayload[0]!.public_exchange.step_index
      && (step.source_bodies[laterId] ?? "").length > 0);
    if (!priorBody) expect(start).toBe(0);
  }
  return { publicFirst, laterId };
}

function assertStandaloneCapsuleExposure(
  result: Awaited<ReturnType<typeof consumePairTrace>>, capsuleIds: readonly string[], excerpt: string
): void {
  const capsules = result.initial.results.filter((row) =>
    row.target.kind === "source_evidence" && row.target.root_kind === "evidence_capsule");
  expect(capsules).toHaveLength(capsuleIds.length);
  for (const objectId of capsuleIds) {
    const capsule = capsules.find((row) => row.target.kind === "source_evidence" && row.target.root_id === objectId);
    expect(capsule?.target).toMatchObject({
      kind: "source_evidence", root_kind: "evidence_capsule", root_id: objectId,
      evidence_object_id: objectId, source_version: NOW,
      content_digest: `sha256:${createHash("sha256").update(excerpt, "utf8").digest("hex")}`
    });
    expect(capsule?.source_lookup_reasons ?? []).toEqual([]);
    expect(result.trace.steps[0]!.source_bodies[objectId]).toBe(excerpt);
    expect(result.trace.termination.source_bodies[objectId]).toBe(excerpt);
    expect(result.trace.termination.preview_complete[objectId]).toBe(true);
    expect(payloadStepsFor(result.trace, objectId)).toEqual([]);
  }
}

function publicPairIdentityOrder(
  result: Awaited<ReturnType<typeof consumePairTrace>>
): string[] {
  const seen: string[] = [];
  const add = (id: string | undefined): void => {
    if (id === undefined || seen.includes(id)) return;
    seen.push(id);
  };
  for (const entry of result.initial.index?.entries ?? []) {
    if (entry.target.kind === "source_evidence") add(entry.target.root_id);
  }
  for (const id of result.trace.first_page_identities) add(id);
  for (const step of result.trace.steps) {
    for (const id of step.public_identities) add(id);
    for (const id of Object.keys(step.source_bodies)) add(id);
    for (const chunk of step.public_exchange.response.chunks) add(chunk.root_id);
    for (const lookup of step.public_exchange.response.source_lookups) {
      if (lookup.target.kind === "source_evidence") add(lookup.target.root_id);
    }
  }
  return seen;
}

function continuationDiagnostic(
  continuation: Readonly<{ continuation_id: string; cursor: string; capability?: string }> | null | undefined
): null | Readonly<{ continuation_id: string; cursor: string; capability: string | null }> {
  if (continuation === null || continuation === undefined) return null;
  return {
    continuation_id: continuation.continuation_id,
    cursor: continuation.cursor,
    capability: continuation.capability ?? null
  };
}

function payloadStepsFor(trace: ConsumptionTrace, rootId: string): ConsumptionTrace["steps"] {
  return trace.steps.filter((step) =>
    step.public_exchange.request.payload_continuation?.root_id === rootId);
}

function recordTrace(
  identity: CaseIdentity,
  canary: CanaryCase,
  trace: ConsumptionTrace,
  receipts: readonly import("@do-soul/alaya-core").ConditionalFieldExecutionReceipt[]
): void {
  traces.push(boundTrace(
    identity.cell, canary, identity.view, identity.enumeration, identity.lookup, trace, receipts
  ));
  completedCases.push(identity);
}

async function attemptCell<T>(identity: CaseIdentity, run: () => Promise<T>): Promise<T> {
  inflightCases.push(identity);
  try {
    return await run();
  } catch (error) {
    noteFailedCase(identity);
    throw error;
  } finally {
    const index = inflightCases.findIndex((item) => caseKey(item) === caseKey(identity));
    if (index >= 0) inflightCases.splice(index, 1);
  }
}

function commitCell(run: Awaited<ReturnType<typeof runPair>>): void {
  traces.push(boundTrace(
    run.identity.cell, run.canary, run.identity.view,
    run.identity.enumeration, run.identity.lookup, run.trace, run.settled
  ));
  completedCases.push(run.identity);
  rows.push(run.row);
}

function commitPairedCells(pair: readonly Awaited<ReturnType<typeof runPair>>[]): void {
  try {
    assertPairedControls(pair.map((run) => run.row));
  } catch (error) {
    for (const run of pair) noteFailedCase(run.identity);
    throw error;
  }
  for (const run of pair) commitCell(run);
}

function noteFailedCase(identity: CaseIdentity): void {
  if (failedCases === "unavailable") {
    failedCases = [identity];
    return;
  }
  if (failedCases.some((item) => caseKey(item) === caseKey(identity))) return;
  failedCases = [...failedCases, identity];
}

function assertAssembledMatchesReconstruction(trace: ConsumptionTrace): void {
  const reconstructed = reconstructedSourceBodies(trace);
  for (const [rootId, body] of Object.entries(trace.termination.source_bodies)) {
    expect(reconstructed[rootId]).toEqual({
      utf8_bytes: Buffer.byteLength(body, "utf8"),
      sha256: createHash("sha256").update(body, "utf8").digest("hex")
    });
  }
}

function observedVitestFailure(suite: Readonly<{
  readonly type?: string;
  readonly tasks?: readonly unknown[];
  readonly result?: Readonly<{ readonly state?: string }>;
}>): boolean | "unavailable" {
  const tests = collectVitestTests(suite);
  if (tests.length === 0) return "unavailable";
  let observed = false;
  for (const test of tests) {
    const state = test.result?.state;
    if (state === "fail") return true;
    if (state === "pass" || state === "skip" || state === "todo") observed = true;
  }
  return observed ? false : "unavailable";
}

function collectVitestTests(task: Readonly<{
  readonly type?: string;
  readonly tasks?: readonly unknown[];
  readonly result?: Readonly<{ readonly state?: string }>;
}>): readonly Readonly<{ readonly result?: Readonly<{ readonly state?: string }> }>[] {
  if (task.type === "test") return [task];
  return (task.tasks ?? []).flatMap((child) => collectVitestTests(child as Readonly<{
    readonly type?: string;
    readonly tasks?: readonly unknown[];
    readonly result?: Readonly<{ readonly state?: string }>;
  }>));
}

function completeSourceBody(canary: CanaryCase): string {
  return `${COMPLETE_SOURCE_MARKER} ${canary.intended} ${"y".repeat(8_000)}`;
}

function cappedSourceBody(canary: CanaryCase): string {
  return `${CAPPED_SOURCE_MARKER} ${canary.intended} ${"x".repeat(90_000)}`;
}

function selectedPublicConsumptionCases(): CaseIdentity[] {
  const cases: CaseIdentity[] = [];
  for (const canary of SOURCE_DISCOVERY_CANARY) {
    for (const view of ["source_only", "mixed"] as const) {
      for (const enumeration of LIVE_ORDINARY_ENUMERATIONS) {
        for (const lookup of ["proposal", "source_text"] as const) {
          cases.push({ cell: "primary", group: canary.group, view, enumeration, lookup });
          cases.push({
            cell: "supplemental_intended_first", group: canary.group, view, enumeration, lookup
          });
        }
      }
    }
    for (const lookup of ["proposal", "source_text"] as const) {
      cases.push({
        cell: "historical_page1", group: canary.group, view: "source_only",
        enumeration: LIVE_ORDINARY_ENUMERATION, lookup
      });
    }
  }
  for (const lookup of ["proposal", "source_text"] as const) {
    cases.push({
      cell: "memory_only", group: SOURCE_DISCOVERY_CANARY[0]!.group, view: "memory_only",
      enumeration: LIVE_ORDINARY_ENUMERATION, lookup
    });
  }
  cases.push({
    cell: "public_first_complete_then_later_read", group: SOURCE_DISCOVERY_CANARY[1]!.group,
    view: "source_only", enumeration: LIVE_ORDINARY_ENUMERATION, lookup: "proposal"
  });
  cases.push({
    cell: "public_first_capped_then_later_complete", group: SOURCE_DISCOVERY_CANARY[1]!.group,
    view: "source_only", enumeration: LIVE_ORDINARY_ENUMERATION, lookup: "proposal"
  });
  return cases;
}
