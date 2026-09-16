import { afterAll, describe, expect, it } from "vitest";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { WS, RUN } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  SOURCE_DISCOVERY_CANARY,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import {
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
  persistRunEvidence,
  type CaseIdentity
} from "./source-discovery-public-consumption-evidence.js";
import {
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

afterAll(() => {
  persistRunEvidence({
    rows,
    traces,
    selected: selectedPublicConsumptionCases(),
    completed: completedCases
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
          proposal: observePlantedDiscovery(planted.database, WS, canary, "proposal", view, "canonical"),
          source_text: observePlantedDiscovery(planted.database, WS, canary, "source_text", view, "canonical")
        };
        planted.database.close();
        closeCachedDatabase(planted.filename);
        await client.ready();
        for (const enumeration of ["canonical", "associative"] as const) {
          const pair: Awaited<ReturnType<typeof runPair>>[] = [];
          for (const lookup of ["proposal", "source_text"] as const) {
            const row = await runPair({
              canary, view, enumeration, lookup, intendedId: planted.intendedId,
              handler, receipts, native: native[lookup], maxResults: PUBLIC_CONSUMPTION_PROTOCOL.max_results,
              cell: "primary"
            });
            assertSettledConsumption(row);
            pair.push(row);
            rows.push(row);
          }
          assertPairedControls(pair);
        }
        if (view === "source_only") {
          for (const lookup of ["proposal", "source_text"] as const) {
            const row = await runPair({
              canary, view, enumeration: "canonical", lookup, intendedId: planted.intendedId,
              handler, receipts, maxResults: PUBLIC_CONSUMPTION_PROTOCOL.historical_max_results,
              cell: "historical_page1"
            });
            assertSettledConsumption(row);
            rows.push(row);
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
        await client.ready();
        for (const enumeration of ["canonical", "associative"] as const) {
          const pair: Awaited<ReturnType<typeof runPair>>[] = [];
          for (const lookup of ["proposal", "source_text"] as const) {
            const row = await runPair({
              canary, view, enumeration, lookup, intendedId: planted.intendedId,
              handler, receipts, maxResults: PUBLIC_CONSUMPTION_PROTOCOL.max_results,
              cell: "supplemental_intended_first"
            });
            assertSettledConsumption(row);
            pair.push(row);
            rows.push(row);
          }
          assertPairedControls(pair);
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
      await client.ready();
      for (const lookup of ["proposal", "source_text"] as const) {
        const scored = await runPair({
          canary, view: "memory_only", enumeration: "canonical", lookup,
          intendedId: planted.intendedId, handler, receipts, maxResults: PUBLIC_CONSUMPTION_PROTOCOL.max_results,
          cell: "memory_only"
        });
        expect(scored.public_source_identities).toEqual([]);
        expect(scored.score.content.has_full_intended).toBe(false);
        expect(scored.score.consumption_attribution).toBe("qualification");
        expect(scored.score.first_page_omission).toBe(true);
        expect(scored.score.first_page_omission_attribution).toBe("absent");
        rows.push(scored);
      }
    });
  }, 90_000);

  it("keeps lookup mode as the only compiled interpretation difference in a pair", () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const proposal = compileCanarySketch(canary, "proposal", "source_only", "canonical");
    const text = compileCanarySketch(canary, "source_text", "source_only", "canonical");
    expect(proposal.query_id).not.toBe(text.query_id);
    expect(proposal.interpretation_proposal?.original_query_digest)
      .toBe(text.interpretation_proposal?.original_query_digest);
  });

  it("completes the first public target then reads a later omitted source through the worker", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const firstBody = `${COMPLETE_SOURCE_MARKER} ${canary.intended} ${"y".repeat(8_000)}`;
    const secondBody = `${TRAILING_SOURCE_MARKER} ${canary.intended} ${"z".repeat(9_000)}`;
    await withOmittedPairWorker(canary, firstBody, secondBody, async (planted, handler, receipts, client) => {
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      const trace = await consumePairTrace(canary, handler, receipts);
      const publicFirst = trace.first_page_identities[0];
      const laterId = trace.first_page_identities.find((id) => id !== publicFirst);
      const bodyById: Record<string, string> = {
        [planted.first_id]: planted.first_body,
        [planted.second_id]: planted.second_body
      };
      expect(trace.first_page_identities).toEqual(expect.arrayContaining([
        planted.first_id,
        planted.second_id
      ]));
      expect(publicFirst).toBeDefined();
      expect(laterId).toBeDefined();
      expect(trace.termination.preview_complete[publicFirst!]).toBe(true);
      expect(trace.termination.source_bodies[publicFirst!]).toBe(bodyById[publicFirst!]);
      expect((trace.termination.source_bodies[laterId!] ?? "").length).toBeGreaterThan(0);
      expect(payloadStepsFor(trace, laterId!).length).toBeGreaterThan(0);
      expect(trace.termination.stop_reason).toMatch(/continuation_exhausted|membership_page_cap|index_invalidated|declared_turn_cap/);
      recordTrace("public_first_complete_then_later_read", canary, trace, receipts);
    });
  }, 90_000);

  it("keeps the first public target incomplete at the per-target expansion cap then fully consumes a later public target", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const publicFirstBody = cappedSourceBody(canary);
    const laterBody = completeSourceBody(canary);
    await withPublicOrderedPairWorker(canary, publicFirstBody, laterBody, async (planted, handler, receipts) => {
      const trace = await consumePairTrace(canary, handler, receipts);
      const publicFirst = trace.first_page_identities[0];
      const laterId = trace.first_page_identities.find((id) => id !== publicFirst);
      expect(publicFirst).toBe(planted.public_first_id);
      expect(laterId).toBe(planted.later_id);
      const cap = PUBLIC_CONSUMPTION_PROTOCOL.max_payload_expansions_per_target;
      const firstPayload = payloadStepsFor(trace, publicFirst!);
      expect(firstPayload).toHaveLength(cap);
      expect(firstPayload.every((step) => step.preview_complete[publicFirst!] !== true)).toBe(true);
      expect(trace.termination.preview_complete[publicFirst!]).toBe(false);
      expect(trace.termination.source_bodies[publicFirst!] ?? "").toContain(CAPPED_SOURCE_MARKER);
      expect(trace.termination.source_bodies[publicFirst!] ?? "").not.toBe(publicFirstBody);
      expect(trace.termination.preview_complete[laterId!]).toBe(true);
      expect(trace.termination.source_bodies[laterId!] ?? "").toContain(COMPLETE_SOURCE_MARKER);
      expect(trace.discarded_capped_incomplete_root_ids).toEqual([publicFirst]);
      expect(trace.cap_remainder).toBe("unread_after_cap");
      expect(trace.termination.discarded_capped_incomplete_root_ids).toEqual([publicFirst]);
      expect(trace.termination.stop_reason).toMatch(/continuation_exhausted|membership_page_cap|index_invalidated|declared_turn_cap/);
      recordTrace("public_first_capped_then_later_complete", canary, trace, receipts);
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
  traces.push(boundTrace(input.cell, input.canary, input.view, input.enumeration, input.lookup, trace, settled));
  completedCases.push({
    cell: input.cell,
    group: input.canary.group,
    view: input.view,
    enumeration: input.enumeration,
    lookup: input.lookup
  });
  return {
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
  };
}

function assertSettledConsumption(row: Awaited<ReturnType<typeof runPair>>): void {
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

function assertPairedControls(pair: readonly Awaited<ReturnType<typeof runPair>>[]): void {
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
): Promise<ConsumptionTrace> {
  return consumePublicSources({
    handler,
    context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
    request: publicSearchRequest(canary, "proposal", "source_only", "canonical"),
    receipts
  });
}

function payloadStepsFor(trace: ConsumptionTrace, rootId: string): ConsumptionTrace["steps"] {
  return trace.steps.filter((step) =>
    step.public_exchange.request.payload_continuation?.root_id === rootId);
}

function recordTrace(
  cell: CaseIdentity["cell"],
  canary: CanaryCase,
  trace: ConsumptionTrace,
  receipts: import("@do-soul/alaya-core").ConditionalFieldExecutionReceipt[]
): void {
  traces.push(boundTrace(cell, canary, "source_only", "canonical", "proposal", trace, receipts));
  completedCases.push({
    cell,
    group: canary.group,
    view: "source_only",
    enumeration: "canonical",
    lookup: "proposal"
  });
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
      for (const enumeration of ["canonical", "associative"] as const) {
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
        enumeration: "canonical", lookup
      });
    }
  }
  for (const lookup of ["proposal", "source_text"] as const) {
    cases.push({
      cell: "memory_only", group: SOURCE_DISCOVERY_CANARY[0]!.group, view: "memory_only",
      enumeration: "canonical", lookup
    });
  }
  cases.push({
    cell: "public_first_complete_then_later_read", group: SOURCE_DISCOVERY_CANARY[1]!.group,
    view: "source_only", enumeration: "canonical", lookup: "proposal"
  });
  cases.push({
    cell: "public_first_capped_then_later_complete", group: SOURCE_DISCOVERY_CANARY[1]!.group,
    view: "source_only", enumeration: "canonical", lookup: "proposal"
  });
  return cases;
}
