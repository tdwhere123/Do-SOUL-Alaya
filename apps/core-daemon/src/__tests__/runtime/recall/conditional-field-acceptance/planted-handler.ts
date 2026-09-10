import { PassThrough } from "node:stream";
import { vi } from "vitest";
import {
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  hashContentDigest,
  hashSourceRecordId,
  type InformationIndex,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import { capableRecallConsumerDeclaration, RecallService, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { ALAYA_SYSEXITS, type AlayaCliContext } from "../../../../cli/bridge.js";
import { createToolsCommand } from "../../../../cli/tools.js";
import { createRecallHandler } from "../../../../mcp-memory/recall/recall-usage-handlers.js";
import { createMcpMemoryToolHandler } from "../../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies } from
  "../../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { INTERPRETATION_CLOCK } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import { WS } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  readersFor,
  runRecall,
  type SourceSlice
} from "../../../../../../../packages/core/src/__tests__/recall/conditional-field-oracle/bound-producer.js";

export { readersFor, runRecall, plantDeployment, openBoundSlice, tombstone, stamp, setScope, setContent, plantNeedles, countingReaders, encodedRecall } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field-oracle/bound-producer.js";
export type { SourceSlice } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field-oracle/bound-producer.js";
export { MEM, WS } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
export { INTERPRETATION_CLOCK, defaultBudget, SNAPSHOT_ID } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field-oracle/finite-worlds.js";

export function recallReadWorkerUrl(): URL {
  return new URL("../../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url);
}

export function plantSourceRecord(database: StorageDatabase, body: string, sourceId = "speaker-a") {
  const content_digest = hashContentDigest(body, fieldContractSha256);
  return new SqliteFieldSourceRecordRepo(database, fieldContractSha256).insert({
    record_id: hashSourceRecordId({
      source_id: sourceId,
      source_version: "v1",
      content_digest
    }, fieldContractSha256),
    workspace_id: WS,
    source_id: sourceId,
    source_version: "v1",
    content_digest,
    evidence_object_id: null,
    recorded_at: "2026-09-05T12:00:00.000Z",
    event_time: "2026-09-05T12:00:00.000Z",
    valid_from: null,
    valid_to: null,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    speaker: null,
    scope_class: null,
    source_body: body
  });
}

export async function recallThroughHandler(
  slice: SourceSlice,
  request: Pick<SoulMemorySearchRequest, "query" | "max_results"> & Partial<Pick<SoulMemorySearchRequest, "dimension" | "domain_tags" | "enumeration_policy" | "result_kind_view" | "interpretation_proposal">> & {
    readonly continuation?: InformationIndex["continuation"];
    readonly now?: string;
  }
) {
  const { dependencies } = createDependencies();
  let ticks = 0;
  const clock = request.now ?? INTERPRETATION_CLOCK;
  const service = new RecallService({
    ...dependencies,
    now: () => new Date(Date.parse(clock) + ticks++ * 1_000).toISOString(),
    observerReaders: readersFor(slice)
  });
  const handler = createRecallHandler({
    deps: {
      recallService: service,
      trustStateRecorder: {
        recordDelivery: vi.fn(async (input) => ({ ...input, audit_event_id: "event1" })),
        recordUsage: vi.fn(async (input) => ({ ...input, audit_event_id: "event2" })),
        findDeliveryById: vi.fn(async () => null)
      },
      memoryService: {
        findByIdScoped: async () => null
      }
    },
    now: () => clock,
    warn: () => undefined,
    generateId: () => "00000000-0000-4000-8000-000000000001"
  });
  const response = await handler({
    ...capableRecallConsumerDeclaration(),
    query: request.query,
    scope_class: null,
    dimension: request.dimension ?? null,
    domain_tags: request.domain_tags ?? null,
    max_results: request.max_results,
    ...(request.continuation === undefined || request.continuation === null
      ? {}
      : { continuation: request.continuation }),
    ...(request.enumeration_policy === undefined ? {} : { enumeration_policy: request.enumeration_policy }),
    ...(request.result_kind_view === undefined ? {} : { result_kind_view: request.result_kind_view }),
    ...(request.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: request.interpretation_proposal })
  }, {
    workspaceId: WS,
    runId: null,
    agentTarget: "codex",
    sessionId: "c06"
  });
  if (response.index === undefined) throw new Error("handler omitted index");
  return { ...response, index: response.index };
}

export function toConsumer(
  response: Awaited<ReturnType<typeof recallThroughHandler>>,
  surface: "mcp" | "cli"
) {
  return {
    schema_version: 1 as const,
    surface,
    bound: true as const,
    note: "real producer",
    query_id: response.index.query_id,
    snapshot_id: response.index.snapshot_id,
    result_version: response.index.result_version,
    provider_calls: 0 as const,
    garden_enqueue: 0 as const,
    index: response.index
  };
}

export async function recallThroughCli(slice: SourceSlice, query: string, maxResults: number) {
  const { dependencies } = createDependencies();
  const service = new RecallService({
    ...dependencies,
    now: () => INTERPRETATION_CLOCK,
    observerReaders: readersFor(slice)
  });
  const command = createToolsCommand({
    handler: createMcpMemoryToolHandler({
      ...createDeps(),
      recallService: service
    }),
    defaultWorkspaceId: WS,
    defaultAgentTarget: "codex"
  });
  const parsed = command.argsSchema.safeParse([
    "call",
    "soul.recall",
    JSON.stringify({
      ...capableRecallConsumerDeclaration(),
      query,
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: maxResults
    }),
    "--workspace",
    WS
  ]);
  if (!parsed.success) throw new Error("CLI args parse failed");
  const result = await command.handler(cliContext(), parsed.data);
  if (result.exitCode !== ALAYA_SYSEXITS.OK) throw new Error(`CLI recall failed: ${String(result.exitCode)}`);
  return result.json as { readonly index?: InformationIndex };
}

function cliContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    jsonRequested: true,
    daemon: { startupSteps: [] },
    ...overrides
  };
}
