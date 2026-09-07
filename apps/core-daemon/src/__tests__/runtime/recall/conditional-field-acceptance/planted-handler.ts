import { PassThrough } from "node:stream";
import { vi } from "vitest";
import {
  type InformationIndex,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import { RecallService } from "@do-soul/alaya-core";
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

export async function recallThroughHandler(
  slice: SourceSlice,
  request: Pick<SoulMemorySearchRequest, "query" | "max_results" | "dimension" | "domain_tags"> & {
    readonly continuation?: InformationIndex["continuation"];
    readonly now?: string;
  }
) {
  const { dependencies } = createDependencies([]);
  let ticks = 0;
  const clock = request.now ?? INTERPRETATION_CLOCK;
  const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
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
    query: request.query,
    scope_class: null,
    dimension: request.dimension ?? null,
    domain_tags: request.domain_tags ?? null,
    max_results: request.max_results,
    ...(request.continuation === undefined || request.continuation === null
      ? {}
      : { continuation: request.continuation })
  }, {
    workspaceId: WS,
    runId: null,
    agentTarget: "codex",
    sessionId: "c06"
  });
  if (response.index === undefined) throw new Error("handler omitted index");
  return response;
}

export function toConsumer(
  response: Awaited<ReturnType<typeof recallThroughHandler>>,
  surface: "mcp" | "cli"
) {
  return {
    schema_version: 1 as const,
    surface,
    bound: true,
    note: "real producer",
    query_id: response.index.query_id,
    snapshot_id: response.index.snapshot_id,
    result_version: response.index.result_version,
    provider_calls: 0,
    garden_enqueue: 0,
    index: response.index
  };
}

export async function recallThroughCli(slice: SourceSlice, query: string, maxResults: number) {
  const { dependencies } = createDependencies([]);
  const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
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
