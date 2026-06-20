import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClaimLifecycleState,
  FormationKind,
  GovernanceResolutionEventType,
  MemoryDimension,
  MemoryGovernanceEventType,
  ObjectLifecycleState,
  ProposalResolutionState,
  RecallContextEventType,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  canonicalGovernanceSubject,
  parseGovernanceResolutionEventPayload,
  parseMemoryGovernanceEventPayload,
  parseRecallContextEventPayload,
  type ClaimForm,
  type MemoryEntry,
  type SoulMemorySearchResponse,
  type SoulProposeMemoryUpdateResponse,
  type SoulReportContextUsageResponse,
  type SoulResolveResponse
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteClaimFormRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteProposalRepo,
  SqliteRunRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";

import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../../index.js";

import { createAlayaMcpServer } from "../../mcp/mcp-server.js";

const PRIMARY_MEMORY_ID = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";

const DRAFT_CLAIM_ID = "3e87241d-1c7d-4ef6-b033-35e8920f95fe";

const PROPOSED_CONTENT = "Use pnpm for workspace commands and record recall usage receipts.";

const TEST_TIMEOUT_MS = 45_000;

const tempDirs: string[] = [];

const originalDataDir = process.env.DATA_DIR;

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

const originalAlayaOpenAiSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;

const originalEmbeddingSupplementOptIn = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;

const originalAlayaConfigDir = process.env.ALAYA_CONFIG_DIR;

const originalCodexHome = process.env.CODEX_HOME;

const originalHome = process.env.HOME;

const originalReviewerIdentity = process.env.ALAYA_REVIEWER_IDENTITY;

const originalReviewerToken = process.env.ALAYA_REVIEWER_TOKEN;

interface AuthenticityHarness {
  readonly dataDir: string;
  callTool<TOutput>(name: string, args: Record<string, unknown>): Promise<TOutput>;
  close(): Promise<void>;
}

interface EvidenceRepos {
  readonly claimFormRepo: SqliteClaimFormRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly memoryRepo: SqliteMemoryEntryRepo;
  readonly proposalRepo: SqliteProposalRepo;
  readonly runRepo: SqliteRunRepo;
  readonly trustStateRepo: SqliteTrustStateRepo;
  readonly workspaceRepo: SqliteWorkspaceRepo;
}

async function createAuthenticityHarness(
  extraSeed?: (repos: EvidenceRepos) => Promise<void> | void
): Promise<AuthenticityHarness> {
  const dataDir = await createTempDataDir();
  configureProcessEnv(dataDir);
  await seedFixture(dataDir, extraSeed);

  const runtime = await createAlayaDaemonRuntime();
  runtime.startBackgroundServices();
  const server = createAlayaMcpServer({
    memoryToolHandler: runtime.services.mcpMemoryToolHandler,
    contextProvider: () => ({
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "codex",
      sessionId: "lane-f-authenticity-session",
      surfaceId: "lane-f-authenticity"
    })
  });
  const client = new Client(
    { name: "lane-f-authenticity", version: "test" },
    { capabilities: {} }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    dataDir,
    async callTool<TOutput>(name: string, args: Record<string, unknown>): Promise<TOutput> {
      const result = await client.callTool({ name, arguments: args });

      if (result.isError === true) {
        const errorText = (result.content as readonly { readonly text?: unknown }[] | undefined)
          ?.map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
          .join("\n");
        throw new Error(`Tool call failed for ${name}: ${errorText}`);
      }

      expect(result.isError).toBeUndefined();
      const structuredContent = result.structuredContent as
        | Readonly<{ ok: true; output: TOutput }>
        | undefined;
      expect(structuredContent).toMatchObject({ ok: true });
      return structuredContent!.output;
    },
    async close(): Promise<void> {
      await client.close();
      await server.close();
      await runtime.shutdown();
    }
  };
}

async function seedFixture(
  dataDir: string,
  extraSeed?: (repos: EvidenceRepos) => Promise<void> | void
): Promise<void> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });

  try {
    const repos: EvidenceRepos = {
      claimFormRepo: new SqliteClaimFormRepo(database),
      eventLogRepo: new SqliteEventLogRepo(database),
      memoryRepo: new SqliteMemoryEntryRepo(database),
      proposalRepo: new SqliteProposalRepo(database),
      runRepo: new SqliteRunRepo(database),
      trustStateRepo: new SqliteTrustStateRepo(database),
      workspaceRepo: new SqliteWorkspaceRepo(database)
    };

    await repos.workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "workspace one",
      root_path: "/tmp/alaya-workspace-1",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await repos.runRepo.create({
      run_id: "run-1",
      workspace_id: "workspace-1",
      title: "Lane F authenticity proof",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await repos.memoryRepo.create(createMemoryEntry());

    if (extraSeed !== undefined) {
      await extraSeed(repos);
    }
  } finally {
    database.close();
  }
}

async function withEvidenceRepos<T>(
  dataDir: string,
  fn: (repos: EvidenceRepos) => Promise<T>
): Promise<T> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });

  try {
    return await fn({
      claimFormRepo: new SqliteClaimFormRepo(database),
      eventLogRepo: new SqliteEventLogRepo(database),
      memoryRepo: new SqliteMemoryEntryRepo(database),
      proposalRepo: new SqliteProposalRepo(database),
      runRepo: new SqliteRunRepo(database),
      trustStateRepo: new SqliteTrustStateRepo(database),
      workspaceRepo: new SqliteWorkspaceRepo(database)
    });
  } finally {
    database.close();
  }
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: PRIMARY_MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:00.000Z",
    created_by: "lane-f-authenticity",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["lane-f-authenticity"],
    workspace_id: "workspace-1",
    run_id: "run-1",
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
    superseded_by: null,
    ...overrides
  };
}

function createDraftClaim(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: DRAFT_CLAIM_ID,
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-14T00:00:00.000Z",
    updated_at: "2026-05-14T00:00:00.000Z",
    created_by: "lane-f-authenticity",
    governance_subject: canonicalGovernanceSubject("tooling", { area: "workspace_commands" }),
    claim_kind: "preference",
    scope_class: ScopeClass.PROJECT,
    enforcement_level: "preferred",
    origin_tier: "user_explicit",
    precedence_basis: "evidence_strength",
    proposition_digest: "Use pnpm for workspace commands.",
    evidence_refs: [],
    source_object_refs: [PRIMARY_MEMORY_ID],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.DRAFT,
    ...overrides
  };
}

async function createTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-lane-f-authenticity-"));
  tempDirs.push(directory);
  return directory;
}

function configureProcessEnv(dataDir: string): void {
  process.env.DATA_DIR = dataDir;
  process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
  process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
  process.env.CODEX_HOME = join(dataDir, "codex-home");
  process.env.HOME = join(dataDir, "home");
  process.env.ALAYA_REVIEWER_IDENTITY = "user:lane-f-authenticity";
  process.env.ALAYA_REVIEWER_TOKEN = "lane-f-authenticity-token";
}

function restoreProcessEnv(): void {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }

  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }

  if (originalAlayaOpenAiSecretRef === undefined) {
    delete process.env.ALAYA_OPENAI_SECRET_REF;
  } else {
    process.env.ALAYA_OPENAI_SECRET_REF = originalAlayaOpenAiSecretRef;
  }

  if (originalEmbeddingSupplementOptIn === undefined) {
    delete process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
  } else {
    process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = originalEmbeddingSupplementOptIn;
  }

  if (originalAlayaConfigDir === undefined) {
    delete process.env.ALAYA_CONFIG_DIR;
  } else {
    process.env.ALAYA_CONFIG_DIR = originalAlayaConfigDir;
  }

  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalReviewerIdentity === undefined) {
    delete process.env.ALAYA_REVIEWER_IDENTITY;
  } else {
    process.env.ALAYA_REVIEWER_IDENTITY = originalReviewerIdentity;
  }

  if (originalReviewerToken === undefined) {
    delete process.env.ALAYA_REVIEWER_TOKEN;
  } else {
    process.env.ALAYA_REVIEWER_TOKEN = originalReviewerToken;
  }
}

afterEach(async () => {
  restoreProcessEnv();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("MCP memory authenticity proof", () => {

  it("creates proposal rows and proposal-created audit events through the real MCP path", async () => {
    const harness = await createAuthenticityHarness();

    try {
      const recall = await harness.callTool<SoulMemorySearchResponse>("soul.recall", {
        query: "pnpm workspace commands",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PREFERENCE,
        domain_tags: null,
        max_results: 3
      });

      const proposal = await harness.callTool<SoulProposeMemoryUpdateResponse>(
        "soul.propose_memory_update",
        {
          target_object_id: PRIMARY_MEMORY_ID,
          proposed_changes: { content: PROPOSED_CONTENT },
          reason: "Authenticity proof proposal.",
          source_delivery_ids: [recall.delivery_id]
        }
      );
      expect(proposal.status).toBe("created");

      const evidence = await withEvidenceRepos(harness.dataDir, async (repos) => {
        const [scopedProposal, events] = await Promise.all([
          repos.proposalRepo.findScopedById(proposal.proposal_id),
          repos.eventLogRepo.queryByEntity("proposal", proposal.proposal_id)
        ]);
        return { scopedProposal, events };
      });

      expect(evidence.scopedProposal).toMatchObject({
        proposal: {
          proposal_id: proposal.proposal_id,
          resolution_state: ProposalResolutionState.PENDING
        },
        target_object_kind: "memory_entry",
        proposed_changes: { content: PROPOSED_CONTENT },
        source_delivery_ids: [recall.delivery_id]
      });

      const createdEvent = evidence.events.find(
        (entry) => entry.event_type === MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED
      );
      expect(createdEvent).toBeDefined();
      expect(
        parseMemoryGovernanceEventPayload(
          MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
          createdEvent!.payload_json as Record<string, unknown>
        )
      ).toMatchObject({
        object_id: proposal.proposal_id,
        object_kind: "proposal",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source_delivery_ids: [recall.delivery_id]
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
