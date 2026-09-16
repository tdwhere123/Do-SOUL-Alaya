import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import {
  RecallService,
  type ConditionalFieldExecutionReceipt
} from "@do-soul/alaya-core";
import {
  closeCachedDatabase,
  SqliteFieldSourceRecordRepo
} from "@do-soul/alaya-storage";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { MEM, NOW, RUN, WS, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  SOURCE_DISCOVERY_CANARY,
  canaryDistractorRelation,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import {
  PUBLIC_CONSUMPTION_PROTOCOL,
  compileCanarySketch,
  insertBoundGist,
  observePlantedDiscovery,
  publicSearchRequest,
  scoreConsumption,
  tapRecallReceipts,
  type ConsumptionStep,
  type ConsumptionTrace,
  type Enumeration,
  type LookupMode,
  type ResultView
} from "./source-discovery-public-consumption.js";

const rows: unknown[] = [];
const traces: unknown[] = [];

afterAll(() => {
  persistRunEvidence();
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
              handler, receipts, native: native[lookup],
              maxResults: PUBLIC_CONSUMPTION_PROTOCOL.historical_max_results,
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

  it("reads a later omitted source after the first public payload target hits the expansion cap", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const firstBody = `FIRST_SOURCE_MARKER ${canary.intended} ${"x".repeat(70_000)}`;
    const secondBody = `SECOND_SOURCE_MARKER ${canary.intended} ${"y".repeat(8_000)}`;
    await withOmittedPairWorker(canary, firstBody, secondBody, async (planted, handler, receipts, client) => {
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      const request = publicSearchRequest(canary, "proposal", "source_only", "canonical");
      const started = receipts.length;
      const trace = await consumePublicSources({
        handler,
        context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
        request,
        receipts
      });
      const bodies = trace.termination.source_bodies;
      expect(trace.first_page_identities).toEqual(expect.arrayContaining([
        planted.firstId,
        planted.secondId
      ]));
      expect(bodies[planted.secondId] ?? "").toContain("SECOND_SOURCE_MARKER");
      expect(trace.termination.payload_expansions).toBeGreaterThanOrEqual(
        PUBLIC_CONSUMPTION_PROTOCOL.max_payload_expansions_per_target + 1
      );
      expect(trace.termination.stop_reason).toMatch(/continuation_exhausted|membership_page_cap|index_invalidated|declared_turn_cap/);
      expect(trace.termination.stop_reason).toBeDefined();
      traces.push(boundTrace("multi_source_cap", canary, "source_only", "canonical", "proposal", trace,
        receipts.slice(started)));
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
  readonly receipts: ConditionalFieldExecutionReceipt[];
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

async function withPlantedWorker(
  canary: CanaryCase,
  view: ResultView,
  intendedFirst: boolean,
  run: (
    planted: {
      readonly database: import("@do-soul/alaya-storage").StorageDatabase;
      readonly filename: string;
      readonly intendedId: string;
    },
    handler: ReturnType<typeof createRecallHandler>,
    receipts: ConditionalFieldExecutionReceipt[],
    client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>
  ) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-public-consumption-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const intended = records.insert({
    ...hashedRecord(WS, canary.intended, "intended"),
    ...(canary.event_time === undefined ? {} : { event_time: canary.event_time })
  });
  const distractorInput = Array.from({ length: 128 }, (_, index) =>
    hashedRecord(WS, canary.distractor, `distractor-${index}`)).find((row) =>
      (intended.record_id < row.record_id) === intendedFirst);
  if (distractorInput === undefined) throw new Error("Could not plant requested physical order");
  const distractor = records.insert(distractorInput);
  insertBoundGist(slice.database, `gist-${intended.record_id}`, canary.intended, intended.record_id,
    intended.content_digest, intended.evidence_object_id, canary.sketch, WS, RUN, NOW);
  insertBoundGist(slice.database, `gist-${distractor.record_id}`, canary.distractor, distractor.record_id,
    distractor.content_digest, distractor.evidence_object_id, canaryDistractorRelation(canary), WS, RUN, NOW);
  if (view !== "source_only") {
    await slice.writeMemory(MEM.r, canary.original_query, MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, `${canary.original_query} second memory`, MemoryDimension.FACT);
  }
  await runPlantedHandler(filename, slice, intended.record_id, run);
}

async function withOmittedPairWorker(
  canary: CanaryCase,
  firstBody: string,
  secondBody: string,
  run: (
    planted: {
      readonly database: import("@do-soul/alaya-storage").StorageDatabase;
      readonly filename: string;
      readonly firstId: string;
      readonly secondId: string;
    },
    handler: ReturnType<typeof createRecallHandler>,
    receipts: ConditionalFieldExecutionReceipt[],
    client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>
  ) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-public-omitted-pair-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
  const first = records.insert(hashedRecord(WS, firstBody, "first-omitted"));
  const second = records.insert(hashedRecord(WS, secondBody, "second-omitted"));
  insertBoundGist(slice.database, `gist-${first.record_id}`, canary.intended, first.record_id,
    first.content_digest, first.evidence_object_id, canary.sketch, WS, RUN, NOW);
  insertBoundGist(slice.database, `gist-${second.record_id}`, canary.intended, second.record_id,
    second.content_digest, second.evidence_object_id, canary.sketch, WS, RUN, NOW);
  const receipts: ConditionalFieldExecutionReceipt[] = [];
  const client = createRecallReadWorkerClient({
    databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
  })!;
  const service = tapRecallReceipts(new RecallService({
    ...createDependencies().dependencies,
    now: () => NOW,
    conditionalFieldPort: client.conditionalFieldPort,
    activeConstraintsPort: client.activeConstraintsPort,
    readSnapshot: client.readSnapshot
  }), receipts);
  const handler = createRecallHandler({
    deps: { ...createDeps(), recallService: service },
    now: () => NOW,
    generateId: randomUUID,
    warn: () => undefined
  });
  try {
    await run({
      database: slice.database,
      filename,
      firstId: first.record_id,
      secondId: second.record_id
    }, handler, receipts, client);
  } finally {
    await client.close();
    try { slice.database.close(); } catch { /* already closed after native observe */ }
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}

async function runPlantedHandler(
  filename: string,
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  intendedId: string,
  run: (
    planted: {
      readonly database: import("@do-soul/alaya-storage").StorageDatabase;
      readonly filename: string;
      readonly intendedId: string;
    },
    handler: ReturnType<typeof createRecallHandler>,
    receipts: ConditionalFieldExecutionReceipt[],
    client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>
  ) => Promise<void>
): Promise<void> {
  const receipts: ConditionalFieldExecutionReceipt[] = [];
  const client = createRecallReadWorkerClient({
    databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
  })!;
  const service = tapRecallReceipts(new RecallService({
    ...createDependencies().dependencies,
    now: () => NOW,
    conditionalFieldPort: client.conditionalFieldPort,
    activeConstraintsPort: client.activeConstraintsPort,
    readSnapshot: client.readSnapshot
  }), receipts);
  const handler = createRecallHandler({
    deps: { ...createDeps(), recallService: service },
    now: () => NOW,
    generateId: randomUUID,
    warn: () => undefined
  });
  try {
    await run({ database: slice.database, filename, intendedId }, handler, receipts, client);
  } finally {
    await client.close();
    try { slice.database.close(); } catch { /* already closed after native observe */ }
    closeCachedDatabase(filename);
    await rm(dirname(filename), { recursive: true, force: true });
  }
}

function boundTrace(
  cell: string,
  canary: CanaryCase,
  view: ResultView,
  enumeration: Enumeration,
  lookup: LookupMode,
  trace: ConsumptionTrace,
  receipts: readonly ConditionalFieldExecutionReceipt[]
): unknown {
  return {
    cell,
    group: canary.group,
    view,
    enumeration,
    lookup,
    first_exposure: trace.first_exposure === null ? null : {
      delivery_id: trace.first_exposure.delivery_id,
      commitment: trace.first_exposure.commitment,
      page_purpose: trace.first_exposure.page_purpose,
      identity: trace.first_exposure.initial?.identity ?? null,
      digest: trace.first_exposure.initial?.digest ?? null
    },
    first_page_identities: trace.first_page_identities,
    steps: trace.steps.map(boundStep),
    termination: boundStep(trace.termination),
    settled_receipts: receipts.map((receipt) => ({
      query_id: receipt.query_id,
      interpretation_id: receipt.interpretation_id,
      snapshot_id: receipt.snapshot_id,
      actual: receipt.actual === undefined ? "unavailable" as const : {
        native_visits: receipt.actual.native_visits,
        native_bytes: receipt.actual.native_bytes,
        retained_bytes_current: receipt.actual.retained_bytes_current
      }
    }))
  };
}

function boundStep(step: ConsumptionStep): unknown {
  return {
    purpose: step.purpose,
    membership_page: step.membership_page,
    payload_expansions: step.payload_expansions,
    cumulative_native_visits: step.cumulative_native_visits,
    cumulative_native_bytes: step.cumulative_native_bytes,
    retained_bytes_current: step.retained_bytes_current,
    public_identities: step.public_identities,
    preview_complete: step.preview_complete,
    logical_index: step.logical_index,
    payload_completeness: step.payload_completeness,
    stop_reason: step.stop_reason ?? null,
    source_body_bytes: Object.fromEntries(Object.entries(step.source_bodies).map(([id, body]) =>
      [id, Buffer.byteLength(body, "utf8")])),
    source_body_sha256: Object.fromEntries(Object.entries(step.source_bodies).map(([id, body]) =>
      [id, createHash("sha256").update(body, "utf8").digest("hex")]))
  };
}

function persistRunEvidence(): void {
  const identity = resultCandidateIdentity();
  const capturedAt = new Date().toISOString();
  const stamp = capturedAt.replaceAll(":", "-");
  const directory = join(evidenceDirectory(), "public-source-consumption-runs", identity.result_sha);
  mkdirSync(directory, { recursive: true });
  writeExclusive(join(directory, `${stamp}-matrix.json`), {
    protocol: PUBLIC_CONSUMPTION_PROTOCOL,
    result_identity: identity,
    captured_at: capturedAt,
    rows
  });
  writeExclusive(join(directory, `${stamp}-traces.json`), {
    result_identity: identity,
    captured_at: capturedAt,
    traces
  });
}

function resultCandidateIdentity(): Readonly<{
  readonly result_sha: string | "unavailable";
  readonly result_tree: string | "unavailable";
}> {
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(), encoding: "utf8"
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    if (porcelain.trim() !== "" || !/^[a-f0-9]{40}$/u.test(sha) || !/^[a-f0-9]{40}$/u.test(tree)) {
      return { result_sha: "unavailable", result_tree: "unavailable" };
    }
    return { result_sha: sha, result_tree: tree };
  } catch {
    return { result_sha: "unavailable", result_tree: "unavailable" };
  }
}

function writeExclusive(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function evidenceDirectory(): string {
  return join(process.cwd(), ".do-it/bench-runs/query-source-discovery");
}
