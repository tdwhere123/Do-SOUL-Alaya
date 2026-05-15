import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  RunMode,
  RunState,
  ScopeClass,
  SignalEventType,
  SoulSignalMaterializedPayloadSchema,
  WorkspaceKind,
  WorkspaceState,
  type SoulEmitCandidateSignalResponse,
  type SoulMemorySearchResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import {
  createAlayaDaemonRuntime,
  resolveSecretRef,
  type AlayaDaemonRuntime,
  type ResolveSecretError
} from "@do-soul/alaya";
import { createAlayaMcpServer } from "@do-soul/alaya/mcp-server";
import { createAlayaCliBridge } from "@do-soul/alaya/cli/bridge";
import { registerAlayaCliCommands } from "@do-soul/alaya/cli/register";

export interface BenchDaemonOptions {
  readonly dataDirRoot?: string;
  readonly workspaceId?: string;
  readonly runId?: string;
  readonly embeddingMode?: BenchEmbeddingMode;
}

export type BenchEmbeddingMode = "disabled" | "env";

export interface SeededMemoryResult {
  /** Durable memory object_id assigned by the signal materializer. */
  readonly memoryId: string;
  /** Signal id that produced the memory (audit trail anchor). */
  readonly signalId: string;
  /** Proposal id created by soul.propose_memory_update on the new memory. */
  readonly proposalId: string;
  /** true iff the source content exceeded SEED_CONTENT_MAX and was truncated. */
  readonly truncated: boolean;
  /** chars clipped from source content; 0 when not truncated. */
  readonly charsClipped: number;
}

export interface BenchDaemonHandle {
  readonly runtime: AlayaDaemonRuntime;
  readonly mcpClient: Client;
  readonly workspaceId: string;
  readonly runId: string;
  readonly dataDir: string;
  dispatchCli(argv: readonly string[]): Promise<{ exitCode: number; json?: unknown }>;
  recall(
    query: string,
    opts?: { maxResults?: number }
  ): Promise<SoulMemorySearchResponse>;
  /**
   * @anchor proposeMemory — full propose+review chain
   *
   * Steps (production-correct audit trail, no direct DB write):
   *   1. soul.emit_candidate_signal — signal_kind=potential_preference,
   *      confidence=0.9, raw_payload.excerpt=content. The daemon's
   *      MaterializationRouter synchronously creates evidence + memory_entry
   *      + claim because signal_kind=potential_preference @ confidence>=0.5
   *      routes to "memory_and_claim" (see packages/soul/.../materialization-router.ts).
   *   2. Read SOUL_SIGNAL_MATERIALIZED event from event_log to recover
   *      the durable memory object_id created by the materializer.
   *   3. soul.propose_memory_update — propose adding a domain_tag on the
   *      new memory so the propose+review event chain fires.
   *   4. soul.review_memory_proposal — verdict=accept, identity+token
   *      bound to ALAYA_REVIEWER_IDENTITY / ALAYA_REVIEWER_TOKEN.
   *
   * Returns { memoryId, signalId, proposalId } so callers can build a
   * sidecar keyed on the durable memory object_id (recall pointers carry
   * the same object_id, so scoring is by id equality — never by string
   * preview overlap).
   */
  proposeMemory(content: string, evidenceRef: string): Promise<SeededMemoryResult>;
  shutdown(): Promise<void>;
}

const MANAGED_ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_PROVIDER_URL",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN"
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

const REVIEWER_IDENTITY = "user:bench-runner";
const REVIEWER_TOKEN = "bench-review-token";

export async function startBenchDaemon(
  opts: BenchDaemonOptions = {}
): Promise<BenchDaemonHandle> {
  const workspaceId = opts.workspaceId ?? "bench-workspace-1";
  const runId = opts.runId ?? "bench-run-1";
  const embeddingMode = opts.embeddingMode ?? "disabled";

  const dataDir =
    opts.dataDirRoot ?? (await mkdtemp(join(tmpdir(), "alaya-bench-")));

  const savedEnv: Partial<Record<ManagedEnvKey, string | undefined>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  const effectiveOpenAiSecretRef =
    embeddingMode === "env" ? resolveBenchOpenAiSecretRef(savedEnv) : "env:OPENAI_API_KEY";
  if (embeddingMode === "env") {
    requireBenchOpenAiSecretRef(effectiveOpenAiSecretRef);
  }

  let runtime: AlayaDaemonRuntime | undefined;
  let server: ReturnType<typeof createAlayaMcpServer> | undefined;
  let mcpClient: Client | undefined;
  let dispatchCliFn:
    | ((argv: readonly string[]) => Promise<{ exitCode: number; json?: unknown }>)
    | undefined;

  try {
    process.env.DATA_DIR = dataDir;
    if (embeddingMode === "env") {
      process.env.ALAYA_OPENAI_SECRET_REF = effectiveOpenAiSecretRef;
      if (savedEnv.OPENAI_API_KEY === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = savedEnv.OPENAI_API_KEY;
      }
      process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "true";
    } else {
      process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
      process.env.OPENAI_API_KEY = "test-openai-key";
      process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
    }
    process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
    process.env.CODEX_HOME = join(dataDir, "codex-home");
    process.env.HOME = join(dataDir, "home");
    process.env.ALAYA_REVIEWER_IDENTITY = REVIEWER_IDENTITY;
    process.env.ALAYA_REVIEWER_TOKEN = REVIEWER_TOKEN;

    runtime = await createAlayaDaemonRuntime();
    runtime.startBackgroundServices();

    server = createAlayaMcpServer({
      memoryToolHandler: runtime.services.mcpMemoryToolHandler,
      contextProvider: () => ({
        workspaceId,
        runId,
        agentTarget: "bench-runner",
        sessionId: `bench-session-${Date.now()}`,
        surfaceId: "bench"
      })
    });

    mcpClient = new Client(
      { name: "alaya-bench-runner", version: "0.3.7" },
      { capabilities: {} }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    dispatchCliFn = makeDispatchCli(runtime);

    const install = await dispatchCliFn([
      "install",
      "--non-interactive",
      JSON.stringify({
        db_path: join(dataDir, "alaya.db"),
        embedding_enabled: embeddingMode === "env",
        default_workspace: workspaceId,
        worktree_enabled: false
      }),
      "--json"
    ]);
    if (install.exitCode !== 0) {
      throw new Error(`alaya install failed with exitCode=${install.exitCode}`);
    }

    const attach = await dispatchCliFn(["attach", "codex", "--yes", "--json"]);
    if (attach.exitCode !== 0) {
      throw new Error(`alaya attach failed with exitCode=${attach.exitCode}`);
    }

    // @anchor bench-workspace-seed — signals.workspace_id / signals.run_id are
    // FK-constrained to workspaces / runs (migration 003-signals.sql). The
    // install command writes the daemon config but does not create rows in
    // those tables. Seed the bench workspace + run directly so the MCP
    // call context (which binds these ids from the trusted context provider)
    // resolves to existing FK rows.
    // see also: apps/core-daemon/src/__tests__/phase6-agent-use-protocol.test.ts
    //   — workspace + run seeding fixture using the same repos.
    await seedBenchWorkspaceAndRun(dataDir, workspaceId, runId);
  } catch (err) {
    try {
      await closeBenchDaemonResources({ mcpClient, server, runtime });
    } finally {
      restoreEnv(savedEnv);
    }
    throw err;
  }

  if (
    runtime === undefined ||
    server === undefined ||
    mcpClient === undefined ||
    dispatchCliFn === undefined
  ) {
    restoreEnv(savedEnv);
    throw new Error("bench daemon startup did not initialize required resources");
  }

  const activeRuntime = runtime;
  const activeServer = server;
  const activeMcpClient = mcpClient;
  const activeDispatchCli = dispatchCliFn;

  async function recall(
    query: string,
    recallOpts: { maxResults?: number } = {}
  ): Promise<SoulMemorySearchResponse> {
    return callMcpTool<SoulMemorySearchResponse>(activeMcpClient, "soul.recall", {
      query,
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: recallOpts.maxResults ?? 10
    });
  }

  async function proposeMemory(
    content: string,
    evidenceRef: string
  ): Promise<SeededMemoryResult> {
    // @anchor bench-seed-content-cap — protocol §soul.emit_candidate_signal
    // caps raw_payload at 16384 characters JSON-serialized. The bench
    // harness seeds dataset turns; LongMemEval-S has turn contents that
    // can exceed 16K chars. Truncate to a safe length (leaving room for
    // the {"excerpt":"..."} JSON wrapper) instead of crashing the run.
    // Trade-off: if the has_answer fact lives past the cutoff, recall
    // cannot find it — that's a structural cap, documented in the bench
    // report.md Scoring contract.
    const SEED_CONTENT_MAX = 15_000;
    const wasTruncated = content.length > SEED_CONTENT_MAX;
    const charsClipped = wasTruncated ? content.length - SEED_CONTENT_MAX : 0;
    const safeContent = wasTruncated
      ? content.slice(0, SEED_CONTENT_MAX) +
        ` [truncated at ${SEED_CONTENT_MAX} chars]`
      : content;

    // Step 1 — emit candidate signal. signal_kind=potential_preference at
    // confidence 0.9 with evidence_refs >= 1 routes to "memory_and_claim"
    // (see materialization-router.ts:160). raw_payload.excerpt becomes
    // the materialized memory_entry.content via buildSignalSummary.
    const signalResponse = await callMcpTool<SoulEmitCandidateSignalResponse>(
      activeMcpClient,
      "soul.emit_candidate_signal",
      {
        signal_kind: "potential_preference",
        object_kind: "fact",
        scope_hint: ScopeClass.PROJECT,
        domain_tags: ["bench-seed"],
        confidence: 0.9,
        evidence_refs: [evidenceRef],
        raw_payload: { excerpt: safeContent }
      }
    );
    if (signalResponse.status !== "emitted") {
      throw new Error(
        `soul.emit_candidate_signal returned unexpected status=${signalResponse.status}`
      );
    }

    // Step 2 — read SOUL_SIGNAL_MATERIALIZED from event_log to find the
    // memory object_id created synchronously by the materialization router.
    // The MCP surface returns only signal_id, so the bench harness consults
    // the daemon's event log directly (read-only). This is an
    // implementation-of-record lookup, not a bypass of governance.
    const memoryId = await readMaterializedMemoryId(
      dataDir,
      signalResponse.signal_id
    );

    // Step 3 — propose update on the materialized memory so the
    // propose+review event chain (SOUL_PROPOSAL_CREATED, SOUL_REVIEW_*,
    // SOUL_PROPOSAL_RESOLVED, SOUL_MEMORY_UPDATED) is written to the
    // audit trail. The change is a no-op-ish domain_tag append; what
    // matters is that the chain fires for every seed.
    const proposeResponse = await callMcpTool<SoulProposeMemoryUpdateResponse>(
      activeMcpClient,
      "soul.propose_memory_update",
      {
        target_object_id: memoryId,
        proposed_changes: {
          domain_tags: ["bench-seed", "bench-reviewed"]
        },
        reason: `bench seed accept for evidence ${evidenceRef}`
      }
    );
    if (proposeResponse.status !== "created") {
      throw new Error(
        `soul.propose_memory_update returned unexpected status=${proposeResponse.status}`
      );
    }

    // Step 4 — accept the proposal under the bench reviewer identity.
    const reviewResponse = await callMcpTool<SoulReviewMemoryProposalResponse>(
      activeMcpClient,
      "soul.review_memory_proposal",
      {
        proposal_id: proposeResponse.proposal_id,
        verdict: "accept",
        reason: "bench seed auto-accept",
        reviewer_identity: REVIEWER_IDENTITY,
        reviewer_token: REVIEWER_TOKEN
      }
    );
    if (reviewResponse.resolution_state !== "accepted") {
      throw new Error(
        `soul.review_memory_proposal returned unexpected state=${reviewResponse.resolution_state}`
      );
    }

    return {
      memoryId,
      signalId: signalResponse.signal_id,
      proposalId: proposeResponse.proposal_id,
      truncated: wasTruncated,
      charsClipped
    };
  }

  async function shutdown(): Promise<void> {
    try {
      await closeBenchDaemonResources({
        mcpClient: activeMcpClient,
        server: activeServer,
        runtime: activeRuntime
      });
    } finally {
      restoreEnv(savedEnv);
    }
  }

  return {
    runtime: activeRuntime,
    mcpClient: activeMcpClient,
    workspaceId,
    runId,
    dataDir,
    dispatchCli: activeDispatchCli,
    recall,
    proposeMemory,
    shutdown
  };
}

function hasUsableEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function resolveBenchOpenAiSecretRef(
  savedEnv: Partial<Record<ManagedEnvKey, string | undefined>>
): string {
  return savedEnv.ALAYA_OPENAI_SECRET_REF?.trim() || "env:OPENAI_API_KEY";
}

function requireBenchOpenAiSecretRef(secretRef: string): void {
  const resolved = resolveSecretRef(secretRef);
  if (!("kind" in resolved)) {
    return;
  }

  throw new Error(formatBenchEmbeddingSecretError(resolved));
}

function formatBenchEmbeddingSecretError(error: ResolveSecretError): string {
  const prefix = "--embedding env requires a resolvable ALAYA_OPENAI_SECRET_REF";
  switch (error.kind) {
    case "env_missing":
      return `${prefix}; missing environment variable ${error.var_name}`;
    case "empty":
      return `${prefix}; ${error.origin} secret is empty`;
    case "file_missing":
      return `${prefix}; referenced file is missing`;
    case "file_unreadable":
      return `${prefix}; referenced file is unreadable`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `${prefix}; keychain secret lookup failed`;
    case "malformed":
      return `${prefix}; secret ref is malformed`;
  }
}

async function closeBenchDaemonResources(resources: {
  readonly mcpClient?: Client;
  readonly server?: ReturnType<typeof createAlayaMcpServer>;
  readonly runtime?: AlayaDaemonRuntime;
}): Promise<void> {
  if (resources.mcpClient !== undefined) {
    try {
      await resources.mcpClient.close();
    } catch {
      // Ignore close errors
    }
  }
  if (resources.server !== undefined) {
    try {
      await resources.server.close();
    } catch {
      // Ignore close errors
    }
  }
  if (resources.runtime !== undefined) {
    try {
      await resources.runtime.shutdown();
    } catch {
      // Ignore close errors
    }
  }
}

function makeDispatchCli(
  runtime: AlayaDaemonRuntime
): (argv: readonly string[]) => Promise<{ exitCode: number; json?: unknown }> {
  return async (argv) => {
    const bridge = createAlayaCliBridge(runtime, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);
    return bridge.dispatch(argv);
  };
}

async function callMcpTool<TOutput>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<TOutput> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const contentArray = Array.isArray(result.content) ? result.content as readonly unknown[] : [];
    const errorText = contentArray
      .map((item) =>
        item !== null && typeof item === "object" && "text" in item && typeof (item as { text: unknown }).text === "string"
          ? (item as { text: string }).text
          : ""
      )
      .join("\n");
    throw new Error(`MCP tool ${name} failed: ${errorText}`);
  }
  const structured = result.structuredContent as
    | Readonly<{ ok: true; output: TOutput }>
    | undefined;
  if (structured?.ok !== true) {
    throw new Error(`MCP tool ${name} returned non-ok structured content`);
  }
  return structured.output;
}

// @anchor readMaterializedMemoryId — bridges signal_id -> durable memory_id
// The MCP surface intentionally does not expose materialization side-effects
// (the agent should only know it emitted a signal). The bench harness reads
// the event_log directly, which is the canonical audit-trail record of the
// materialization. initDatabase caches connections by path so this opens the
// same handle the daemon already uses — do not close the connection here or
// the daemon will lose its DB.
async function readMaterializedMemoryId(
  dataDir: string,
  signalId: string
): Promise<string> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const events = await eventLogRepo.queryByEntity("candidate_memory_signal", signalId);
  for (const event of events) {
    if (event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED) {
      continue;
    }
    const payload = SoulSignalMaterializedPayloadSchema.parse(event.payload_json);
    const memoryObject = payload.created_objects.find(
      (obj) => obj.object_kind === "memory_entry"
    );
    if (memoryObject !== undefined) {
      return memoryObject.object_id;
    }
  }
  throw new Error(
    `Signal ${signalId} did not materialize a memory_entry — check signal_kind / confidence / evidence_refs routing.`
  );
}

async function seedBenchWorkspaceAndRun(
  dataDir: string,
  workspaceId: string,
  runId: string
): Promise<void> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const workspaceRepo = new SqliteWorkspaceRepo(db);
  const runRepo = new SqliteRunRepo(db);
  workspaceRepo.create({
    workspace_id: workspaceId,
    name: workspaceId,
    root_path: join(dataDir, "bench-workspace-root"),
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title: `bench run ${runId}`,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function restoreEnv(saved: Partial<Record<ManagedEnvKey, string | undefined>>): void {
  for (const key of MANAGED_ENV_KEYS) {
    const prev = saved[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}
