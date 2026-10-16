import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import {
  SourceIndexAcquisition, SourceIndexBackfill, SourceIndexLifecycle, createAuditedSourceAdmission, fieldContractSha256
} from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import {
  SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceIndexConfiguration, type SourceIndexSelection, type SourceSemanticWorkerRequest
} from "@do-soul/alaya-protocol";
import type { SourceEmbeddingBinding } from "../../../../../../packages/core/src/embedding-recall/source-embedding-runtime.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient, type RecallReadWorkerClient }
  from "../../../runtime/recall/recall-read-worker-client.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { callAlayaMcpMemoryTool } from "../../../mcp/server/mcp-server.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { assertBuiltWorker, builtWorkerUrl } from "./recall-read-worker-client-fixture.js";

export { WS };
export const CLOCK = "2026-09-18T00:00:00.000Z";
export const ORIGINAL = "Why delayed?";
export const RAW = "Harbor opening was put off.";
export const SCOPES = { mode: "named" as const, scopes: ["project"] };
export const INDEX_BUDGET = { work: 100_000, native_bytes: 16 * 1024 * 1024 };
export const QUERY_BUDGET = { schema_version: 1 as const, work_units: 200_000, memory_bytes: 4_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
export const SIMULATED_CONFIGURATION: SourceIndexConfiguration = { revision: "simulated-axis-fixture-v1", profile: {
  provider_kind: "local_onnx", model_id: "simulated-fixed-axis-no-model", model_revision: "fixture-v1",
  artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "simulated-token-count-v1",
  dimensions: 3, preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 32,
  windowing: "utf8-byte-windows.v1", window_bytes: 4096
} };
export const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
export type IndexedSource = Readonly<{ id: string; text: string; scope?: "project" | "global_core";
  vector?: readonly number[]; indexed?: false }>;

/** Explicit simulation: independently authored axes, not a provider, tokenizer, ONNX model or recorded cache.
 * The production backfill/preparation owners still validate every input digest, profile and accepted vector.
 */
function simulatedBinding(selection: SourceIndexSelection, axis: (text: string) => readonly number[],
  outsideTransaction: () => void) {
  const embedInputs = vi.fn<SourceEmbeddingBinding["embedInputs"]>(async (inputs, options) => {
    outsideTransaction();
    expect(options.profile_id).toBe(selection.profile_id);
    expect(options.signal?.aborted).toBe(false);
    return inputs.map(input => ({ status: "embedded" as const, input_id: input.input_id,
      input_digest: digest(input.text), vector: new Float32Array(axis(input.text)), token_count: 2, truncated: false as const }));
  });
  return { status: "ready" as const, profile: selection.configuration.profile, profile_id: selection.profile_id, embedInputs };
}

export async function withIndexedSources(sources: readonly IndexedSource[], body: (fixture: IndexFixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-index-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const clients: RecallReadWorkerClient[] = [];
  try {
    const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
    const admission = createAuditedSourceAdmission({ stores, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256 });
    const admit = async (source: IndexedSource, version = "1") => (await admission.admit({
      workspace_id: WS, source_id: source.id, source_version: version, content_bytes: source.text,
      evidence_object_id: null, recorded_at: version === "1" ? CLOCK : "2026-09-18T00:00:01.000Z",
      event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: source.scope ?? "project", spans: []
    }, { workspaceId: WS })).record;
    const indexed = sources.filter(source => source.indexed !== false);
    for (const source of indexed) await admit(source);
    const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
    const lifecycle = new SourceIndexLifecycle(repository, fieldContractSha256);
    const selection = lifecycle.select(WS, SIMULATED_CONFIGURATION), generation = lifecycle.begin(selection);
    let captured = lifecycle.capture(WS, generation.generation_id, 128, INDEX_BUDGET);
    expect(captured.generation.reason).not.toBe("native_source_unknown");
    while (!captured.generation.enumeration_complete) {
      expect(captured.added).toBeGreaterThan(0);
      captured = lifecycle.capture(WS, generation.generation_id, 128, INDEX_BUDGET);
    }
    const targets = repository.listTargets(WS, generation.generation_id, null, 128);
    expect(targets).toHaveLength(indexed.length);
    const outsideTransaction = () => { expect(database.connection.inTransaction).toBe(false); };
    const backfillBinding = simulatedBinding(selection, text => sources.find(source => source.text === text)?.vector ?? [0, 1, 0],
      outsideTransaction);
    for (const target of targets) {
      const result = await new SourceIndexBackfill(lifecycle).step({ selection, generation_id: generation.generation_id,
        root_key: target.root_key, binding: backfillBinding, budget: { ...INDEX_BUDGET,
          model_inputs: 128, input_bytes: 1_000_000, max_body_bytes: 1_000_000 },
        deadline_ms: Date.now() + 60_000, signal: new AbortController().signal });
      expect(result).toMatchObject({ status: "root_complete", accepted_vectors: 1,
        resources: { model_inputs_submitted: 1, model_execution_work: "unknown", native_accounting: "complete" } });
    }
    expect(lifecycle.publish(WS, generation.generation_id)).toEqual({ status: "accepted" });
    expect(repository.generation(WS, generation.generation_id)).toMatchObject({ status: "ready",
      enumeration_complete: true, target_count: indexed.length, completed_count: indexed.length });
    // Later real admissions make coverage partial without fabricating or changing the active generation.
    for (const source of sources.filter(source => source.indexed === false)) await admit(source);
    const queryBinding = simulatedBinding(selection, () => [1, 0, 0], outsideTransaction);
    const prepareQuery = vi.fn(async (input: { navigation: string; signal: AbortSignal; remainingMs: () => number }) => {
      const state = repository.state(WS);
      return SourceIndexAcquisition.prepareQuery({ ...input, selection: "selection" in state ? state.selection : null,
        bind: async () => queryBinding });
    });
    const openClient = async () => {
      assertBuiltWorker();
      // NODE_OPTIONS is inherited too, but explicit execArgv protects direct Vitest invocations.
      const guard = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
      process.execArgv.push(guard);
      let client;
      try { client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl,
        workerCount: 1, prepareSourceQuery: prepareQuery })!; }
      finally { process.execArgv.splice(process.execArgv.lastIndexOf(guard), 1); }
      clients.push(client);
      await client.ready();
      return client;
    };
    const fixture = { database, filename, repository, lifecycle, selection, generation, targets, admit,
      backfillBinding, queryBinding, prepareQuery, openClient };
    await body(fixture);
  } finally {
    try { for (const client of clients) await client.close(); }
    finally { database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
  }
}
export type IndexFixture = {
  database: Awaited<ReturnType<typeof createRecallRealStorage>>["database"];
  filename: string;
  repository: SqliteSourceIndexRepository;
  lifecycle: SourceIndexLifecycle;
  selection: SourceIndexSelection;
  generation: ReturnType<SourceIndexLifecycle["begin"]>;
  targets: ReturnType<SqliteSourceIndexRepository["listTargets"]>;
  admit(source: IndexedSource, version?: string): Promise<Awaited<ReturnType<ReturnType<typeof createAuditedSourceAdmission>["admit"]>>["record"]>;
  backfillBinding: ReturnType<typeof simulatedBinding>;
  queryBinding: ReturnType<typeof simulatedBinding>;
  prepareQuery: ReturnType<typeof vi.fn<(input: { navigation: string; signal: AbortSignal; remainingMs: () => number }) =>
    ReturnType<typeof SourceIndexAcquisition.prepareQuery>>>;
  openClient(): Promise<RecallReadWorkerClient>;
};

export async function workerCall<K extends SourceSemanticWorkerRequest["kind"]>(client: RecallReadWorkerClient,
  request: Extract<SourceSemanticWorkerRequest, { kind: K }>, scopes: readonly string[] = ["project"]) {
  const result = await client.sourceSemanticsPort!.execute({ workspace_id: WS, as_of: CLOCK,
    authorized_scopes: { mode: "named", scopes }, request });
  if (result.kind !== request.kind) throw new Error("worker operation mismatch");
  return result as Extract<typeof result, { kind: K }>;
}
export function publicMcp(client: RecallReadWorkerClient) {
  const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort });
  const context = { workspaceId: WS, runId: "run-1", agentTarget: "codex", sessionId: "simulated-source-index" };
  return async (arguments_: unknown) => {
    const result = await callAlayaMcpMemoryTool({ memoryToolHandler: handler, contextProvider: () => context },
      "soul.interpretation", SoulInterpretationRequestSchema.parse(arguments_));
    const envelope = result.structuredContent as { ok?: boolean; output?: unknown };
    expect(envelope.ok).toBe(true);
    return SoulInterpretationResponseSchema.parse(envelope.output);
  };
}

export const obstructedSources: readonly IndexedSource[] = [
  ...Array.from({ length: 513 }, (_, index) => ({ id: `a-${String(index).padStart(3, "0")}`,
    text: `Granite walls ${index}.`, scope: "global_core" as const, indexed: false as const })),
  { id: "z-vector", text: RAW, vector: [1, 0, 0] }
];
