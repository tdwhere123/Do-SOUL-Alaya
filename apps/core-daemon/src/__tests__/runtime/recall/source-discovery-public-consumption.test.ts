import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  PUBLIC_CONSUMPTION_PROTOCOL,
  compileCanarySketch,
  consumePublicSources,
  insertBoundGist,
  observePlantedDiscovery,
  publicSearchRequest,
  scoreConsumption,
  tapRecallReceipts,
  type Enumeration,
  type LookupMode,
  type ResultView
} from "./source-discovery-public-consumption.js";

const rows: unknown[] = [];

afterAll(() => {
  const directory = evidenceDirectory();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "public-source-consumption-matrix.json"), `${JSON.stringify({
    protocol: PUBLIC_CONSUMPTION_PROTOCOL,
    captured_at: new Date().toISOString(),
    rows
  }, null, 2)}\n`);
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
          for (const lookup of ["proposal", "source_text"] as const) {
            rows.push(await runPair({
              canary, view, enumeration, lookup, intendedId: planted.intendedId,
              handler, receipts, native: native[lookup], maxResults: PUBLIC_CONSUMPTION_PROTOCOL.max_results,
              cell: "primary"
            }));
          }
        }
        if (view === "source_only") {
          for (const lookup of ["proposal", "source_text"] as const) {
            rows.push(await runPair({
              canary, view, enumeration: "canonical", lookup, intendedId: planted.intendedId,
              handler, receipts, native: native[lookup],
              maxResults: PUBLIC_CONSUMPTION_PROTOCOL.historical_max_results,
              cell: "historical_page1"
            }));
          }
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
        expect(scored.score.attribution).toBe("qualification");
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
  const trace = await consumePublicSources({
    handler: input.handler,
    context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
    request,
    receipts: input.receipts
  });
  expect(trace.first_exposure?.initial).not.toBeNull();
  expect(trace.first_exposure?.page_purpose === "membership"
    || trace.first_exposure?.page_purpose === "retry").toBe(true);
  const score = scoreConsumption(input.canary, input.intendedId, trace, input.native, input.view);
  const publicSourceIdentities = [...new Set(trace.steps.flatMap((step) =>
    Object.keys(step.source_bodies)))];
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
    termination: {
      purpose: trace.termination.purpose,
      membership_page: trace.termination.membership_page,
      payload_expansions: trace.termination.payload_expansions,
      cumulative_native_visits: trace.termination.cumulative_native_visits,
      cumulative_native_bytes: trace.termination.cumulative_native_bytes,
      retained_bytes_current: trace.termination.retained_bytes_current,
      logical_index: trace.termination.logical_index,
      payload_completeness: trace.termination.payload_completeness
    },
    public_source_identities: publicSourceIdentities,
    score
  };
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
    await run({ database: slice.database, filename, intendedId: intended.record_id }, handler, receipts, client);
  } finally {
    await client.close();
    try { slice.database.close(); } catch { /* already closed after native observe */ }
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}

function evidenceDirectory(): string {
  return join(process.cwd(), ".do-it/bench-runs/query-source-discovery");
}
