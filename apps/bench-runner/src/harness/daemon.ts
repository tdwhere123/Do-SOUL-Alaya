import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  type MemoryEntry,
  type SoulMemorySearchResponse,
  type SoulReviewMemoryProposalResponse
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
// Cross-package imports: bench-runner depends on core-daemon via @do-soul/alaya.
// The daemon runtime and MCP server are the integration points only.
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "@do-soul/alaya";
import { createAlayaMcpServer } from "@do-soul/alaya/mcp-server";
import { createAlayaCliBridge } from "@do-soul/alaya/cli/bridge";
import { registerAlayaCliCommands } from "@do-soul/alaya/cli/register";

export interface BenchDaemonOptions {
  /** Root directory for the daemon's data files. A temp dir is created if omitted. */
  readonly dataDirRoot?: string;
  /** Workspace id used for the bench run (default: "bench-workspace-1"). */
  readonly workspaceId?: string;
  /** Run id used for the bench run (default: "bench-run-1"). */
  readonly runId?: string;
}

export interface BenchDaemonHandle {
  readonly runtime: AlayaDaemonRuntime;
  readonly mcpClient: Client;
  readonly workspaceId: string;
  readonly runId: string;
  readonly dataDir: string;
  /** Low-level MCP tool caller. Prefer recall / proposeMemory / acceptProposal. */
  dispatchCli(argv: readonly string[]): Promise<{ exitCode: number; json?: unknown }>;
  /** Recall memories matching query. */
  recall(
    query: string,
    opts?: { maxResults?: number }
  ): Promise<SoulMemorySearchResponse>;
  /** Propose a new memory (content + evidence ref). Returns the proposal id. */
  proposeMemory(content: string, evidenceRef: string): Promise<string>;
  /** Accept a pending proposal by id. */
  acceptProposal(proposalId: string): Promise<SoulReviewMemoryProposalResponse>;
  /** Shut down daemon and restore process env. */
  shutdown(): Promise<void>;
}

// Saved env vars restored by shutdown()
const MANAGED_ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN"
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

/**
 * Start an in-process Alaya daemon wired with an InMemoryTransport MCP client.
 * The caller must call handle.shutdown() after the session to restore env and
 * free the database handle.
 */
export async function startBenchDaemon(
  opts: BenchDaemonOptions = {}
): Promise<BenchDaemonHandle> {
  const workspaceId = opts.workspaceId ?? "bench-workspace-1";
  const runId = opts.runId ?? "bench-run-1";

  const dataDir =
    opts.dataDirRoot ?? (await mkdtemp(join(tmpdir(), "alaya-bench-")));

  // Save current env for restoration on shutdown.
  const savedEnv: Partial<Record<ManagedEnvKey, string | undefined>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  // Set the required env for the in-process daemon.
  process.env.DATA_DIR = dataDir;
  process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
  process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
  process.env.CODEX_HOME = join(dataDir, "codex-home");
  process.env.HOME = join(dataDir, "home");
  process.env.ALAYA_REVIEWER_IDENTITY = "user:bench-runner";
  process.env.ALAYA_REVIEWER_TOKEN = "bench-review-token";

  const runtime = await createAlayaDaemonRuntime();
  runtime.startBackgroundServices();

  const server = createAlayaMcpServer({
    memoryToolHandler: runtime.services.mcpMemoryToolHandler,
    contextProvider: () => ({
      workspaceId,
      runId,
      agentTarget: "bench-runner",
      sessionId: `bench-session-${Date.now()}`,
      surfaceId: "bench"
    })
  });

  const mcpClient = new Client(
    { name: "alaya-bench-runner", version: "0.3.5" },
    { capabilities: {} }
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  // Install + attach so MCP tools come live.
  const dispatchCliFn = makeDispatchCli(runtime);

  const install = await dispatchCliFn([
    "install",
    "--non-interactive",
    JSON.stringify({
      db_path: join(dataDir, "alaya.db"),
      embedding_enabled: false,
      default_workspace: workspaceId,
      worktree_enabled: false
    }),
    "--json"
  ]);
  if (install.exitCode !== 0) {
    await mcpClient.close();
    await server.close();
    await runtime.shutdown();
    restoreEnv(savedEnv);
    throw new Error(`alaya install failed with exitCode=${install.exitCode}`);
  }

  const attach = await dispatchCliFn(["attach", "codex", "--yes", "--json"]);
  if (attach.exitCode !== 0) {
    await mcpClient.close();
    await server.close();
    await runtime.shutdown();
    restoreEnv(savedEnv);
    throw new Error(`alaya attach failed with exitCode=${attach.exitCode}`);
  }

  async function recall(
    query: string,
    recallOpts: { maxResults?: number } = {}
  ): Promise<SoulMemorySearchResponse> {
    return callMcpTool<SoulMemorySearchResponse>(mcpClient, "soul.recall", {
      query,
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: recallOpts.maxResults ?? 10
    });
  }

  // @anchor bench-seed — direct storage write bypasses propose-review flow.
  // soul.propose_memory_update requires an existing target_object_id; there is
  // no MCP "create" verb. We seed bench fixtures directly via SqliteMemoryEntryRepo
  // and return the new object_id as the "proposal token" that acceptProposal confirms.
  async function proposeMemory(
    content: string,
    evidenceRef: string
  ): Promise<string> {
    const objectId = randomUUID();
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      object_id: objectId,
      object_kind: "memory_entry",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: now,
      updated_at: now,
      created_by: "bench-runner",
      dimension: MemoryDimension.FACT,
      source_kind: SourceKind.SEED,
      formation_kind: FormationKind.EXTRACTED,
      scope_class: ScopeClass.PROJECT,
      content,
      domain_tags: ["bench-seed"],
      evidence_refs: [evidenceRef],
      workspace_id: workspaceId,
      run_id: runId,
      surface_id: null,
      storage_tier: StorageTier.HOT,
      activation_score: 0.9,
      retention_score: 0.9,
      manifestation_state: "excerpt",
      retention_state: "working",
      decay_profile: "stable",
      confidence: 1,
      last_used_at: null,
      last_hit_at: null,
      reinforcement_count: 0,
      contradiction_count: 0,
      superseded_by: null
    };

    // initDatabase caches connections by path; the daemon holds the same
    // connection. Do not close() — closing would tear down the daemon's DB.
    const db = initDatabase({ filename: join(dataDir, "alaya.db") });
    const repo = new SqliteMemoryEntryRepo(db);
    await repo.create(entry);
    return objectId;
  }

  // acceptProposal is a no-op for bench seeds: the memory was already written
  // by proposeMemory. We return a synthetic accepted response.
  async function acceptProposal(
    proposalId: string
  ): Promise<SoulReviewMemoryProposalResponse> {
    return {
      proposal_id: proposalId,
      resolution_state: "accepted"
    } as unknown as SoulReviewMemoryProposalResponse;
  }

  async function shutdown(): Promise<void> {
    try {
      await mcpClient.close();
    } catch {
      // Ignore close errors
    }
    try {
      await server.close();
    } catch {
      // Ignore close errors
    }
    await runtime.shutdown();
    restoreEnv(savedEnv);
  }

  return {
    runtime,
    mcpClient,
    workspaceId,
    runId,
    dataDir,
    dispatchCli: dispatchCliFn,
    recall,
    proposeMemory,
    acceptProposal,
    shutdown
  };
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
