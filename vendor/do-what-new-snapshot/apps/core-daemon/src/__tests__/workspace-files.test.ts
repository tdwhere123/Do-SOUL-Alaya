import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceKind,
  type DelegatedWorkerRun,
  type ToolExecutionRecord
} from "@do-what/protocol";
import {
  CoreError,
  EngineBindingService,
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteBootstrappingRecordRepo,
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteToolExecutionRecordRepo,
  SqliteToolSpecRepo,
  SqliteWorkerRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { GitCommandError } from "../git/diff.js";
import { registerWorkspaceFileRoutes } from "../routes/workspace-files.js";
import { SseManager } from "../sse/sse-manager.js";
import { SqliteWorkspaceEngineConfigRepo } from "../services/workspace-engine-config-repo.js";
import {
  configureWorkspacePrincipalCodingEngine,
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { createFixtureRepo } from "./fixtures/fixture-repo-setup.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly toolExecutionRecordRepo: SqliteToolExecutionRecordRepo | undefined;
  readonly workerRunRepo: SqliteWorkerRunRepo;
}

const databases = new Set<StorageDatabase>();
const tempDirectories = new Set<string>();

afterEach(async () => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();

  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("workspace file routes", () => {
  it("aggregates changed files from affected_paths without requiring a git binding", async () => {
    const { app, toolExecutionRecordRepo } = await createTestContext();
    const workspace = await createWorkspace(app, "workspace-files-changed");
    const run = await createRun(app, workspace.workspace_id, "changed files run");

    await toolExecutionRecordRepo.insert(
      createExecutionRecord({
        execution_id: "exec-001",
        requesting_run_id: run.run_id,
        started_at: "2026-04-23T00:00:00.000Z",
        ended_at: "2026-04-23T00:01:00.000Z",
        affected_paths: ["src/index.ts", "docs/README.md"]
      })
    );
    await toolExecutionRecordRepo.insert(
      createExecutionRecord({
        execution_id: "exec-002",
        requesting_run_id: run.run_id,
        started_at: "2026-04-23T00:04:00.000Z",
        ended_at: "2026-04-23T00:05:00.000Z",
        affected_paths: ["docs/README.md"]
      })
    );
    await toolExecutionRecordRepo.insert(
      createExecutionRecord({
        execution_id: "exec-003",
        requesting_run_id: run.run_id,
        started_at: "2026-04-23T00:06:00.000Z",
        ended_at: "2026-04-23T00:06:30.000Z",
        affected_paths: null
      })
    );

    const response = await app.request(
      `/workspaces/${workspace.workspace_id}/files/changed?runId=${run.run_id}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        run_id: run.run_id,
        repo_path: "/tmp/workspace-files-changed",
        files: [
          {
            path: "docs/README.md",
            tool_call_ids: ["exec-001", "exec-002"],
            first_seen_at: "2026-04-23T00:01:00.000Z",
            last_seen_at: "2026-04-23T00:05:00.000Z"
          },
          {
            path: "src/index.ts",
            tool_call_ids: ["exec-001"],
            first_seen_at: "2026-04-23T00:01:00.000Z",
            last_seen_at: "2026-04-23T00:01:00.000Z"
          }
        ]
      }
    });
  });

  it("rejects include_exec=true with 501 while keeping the route git-independent", async () => {
    const { app } = await createTestContext();
    const workspace = await createWorkspace(app, "workspace-files-include-exec");

    const response = await app.request(
      `/workspaces/${workspace.workspace_id}/files/changed?runId=run_missing&include_exec=true`
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "exec_parsing_unavailable"
      }
    });
  });

  it("rejects malformed include_exec values with 400 instead of surfacing a 500", async () => {
    const { app } = await createTestContext();
    const workspace = await createWorkspace(app, "workspace-files-include-exec-invalid");

    const response = await app.request(
      `/workspaces/${workspace.workspace_id}/files/changed?runId=run_missing&include_exec=maybe`
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "invalid_ref_arg"
      }
    });
  });

  it("does not leak worker-run changed files across workspaces", async () => {
    const { app, toolExecutionRecordRepo, workerRunRepo } = await createTestContext();
    const workspaceA = await createWorkspace(app, "workspace-files-a");
    const workspaceB = await createWorkspace(app, "workspace-files-b");
    const principalRun = await createRun(app, workspaceB.workspace_id, "worker owner run");

    await workerRunRepo.insert(
      createWorkerRun({
        worker_run_id: "worker-run-cross-workspace",
        principal_run_id: principalRun.run_id,
        workspace_id: workspaceB.workspace_id,
        requesting_run_id: principalRun.run_id
      })
    );
    await toolExecutionRecordRepo.insert(
      createExecutionRecord({
        execution_id: "exec-worker-cross-workspace",
        requested_by: "worker",
        requesting_run_id: "worker-run-cross-workspace",
        affected_paths: ["secrets/worker.txt"]
      })
    );

    const response = await app.request(
      `/workspaces/${workspaceA.workspace_id}/files/changed?runId=worker-run-cross-workspace`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        workspace_id: workspaceA.workspace_id,
        run_id: "worker-run-cross-workspace",
        repo_path: "/tmp/workspace-files-a",
        files: []
      }
    });
  });

  it("fails closed for orphaned run ids whose workspace ownership cannot be proven", async () => {
    const app = new Hono();
    const toolExecutionRecordRepo = {
      listByRunId: vi.fn(async () => [
        createExecutionRecord({
          execution_id: "exec-orphan-principal",
          requesting_run_id: "orphan-run-id",
          affected_paths: ["secrets/principal.txt"]
        })
      ])
    };
    registerWorkspaceFileRoutes(app, {
      workspaceService: {
        getById: async () => ({
          workspace_id: "workspace-orphan",
          root_path: "/tmp/workspace-files-orphaned-run",
          repo_path: null
        })
      },
      runService: {
        getById: async () => {
          throw new CoreError("NOT_FOUND", "run missing");
        }
      },
      workerRunRepo: {
        getById: async () => null
      },
      toolExecutionRecordRepo
    });

    const response = await app.request("/workspaces/workspace-orphan/files/changed?runId=orphan-run-id");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        workspace_id: "workspace-orphan",
        run_id: "orphan-run-id",
        repo_path: "/tmp/workspace-files-orphaned-run",
        files: []
      }
    });
    expect(toolExecutionRecordRepo.listByRunId).not.toHaveBeenCalled();
  });

  it("returns 409 for diff when the workspace has no git binding", async () => {
    const { app } = await createTestContext();
    const workspace = await createWorkspace(app, "workspace-files-diff-unbound");

    const response = await app.request(
      `/workspaces/${workspace.workspace_id}/files/diff?path=src/app.ts`
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "workspace_not_bound",
        status: "unbound"
      }
    });
  });

  it("returns a unified diff for a bound workspace repo and rejects option-prefixed path args", async () => {
    const { app } = await createTestContext();
    const fixture = await createFixtureRepo();
    tempDirectories.add(fixture.repoPath);
    const workspace = await createWorkspace(app, "workspace-files-diff-bound");

    await fixture.write("README.md", "# fixture repo\n");
    await fixture.write("src/app.ts", "export const value = 1;\n");
    await fixture.commitAll("initial commit");
    await bindWorkspaceRepo(app, workspace.workspace_id, fixture.repoPath);
    await fixture.write("src/app.ts", "export const value = 2;\n");

    const diffResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/files/diff?path=src/app.ts`
    );

    expect(diffResponse.status).toBe(200);
    await expect(diffResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        repo_path: fixture.repoPath,
        path: "src/app.ts",
        since: "HEAD",
        against: "working_tree",
        binary: false,
        added: false,
        deleted: false,
        unified_diff: expect.stringContaining("+export const value = 2;")
      }
    });

    const invalidPathResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/files/diff?path=--upload-pack%3Devil`
    );

    expect(invalidPathResponse.status).toBe(400);
    await expect(invalidPathResponse.json()).resolves.toEqual({
      success: false,
      error: {
        code: "invalid_ref_arg"
      }
    });

    const pathspecMagicResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/files/diff?path=%3A(glob)**`
    );

    expect(pathspecMagicResponse.status).toBe(400);
    await expect(pathspecMagicResponse.json()).resolves.toEqual({
      success: false,
      error: {
        code: "invalid_ref_arg"
      }
    });
  });

  it("returns git log entries for a bound repo and 409 invalid when a persisted binding drifts", async () => {
    const { app } = await createTestContext();
    const fixture = await createFixtureRepo();
    tempDirectories.add(fixture.repoPath);
    const workspace = await createWorkspace(app, "workspace-files-log");

    await fixture.write("README.md", "# fixture repo\n");
    await fixture.write("src/app.ts", "export const value = 1;\n");
    await fixture.commitAll("initial commit");
    await bindWorkspaceRepo(app, workspace.workspace_id, fixture.repoPath);
    await fixture.write("src/app.ts", "export const value = 2;\n");
    await fixture.runGit(["add", "src/app.ts"]);
    await fixture.runGit(["commit", "-m", "update src app"]);

    const successResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/git/log?limit=1&path=src/app.ts`
    );

    expect(successResponse.status).toBe(200);
    await expect(successResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        repo_path: fixture.repoPath,
        commits: [
          {
            subject: "update src app",
            short_sha: expect.any(String),
            sha: expect.any(String)
          }
        ]
      }
    });

    const invalidPathResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/git/log?limit=1&path=%3A(glob)**`
    );

    expect(invalidPathResponse.status).toBe(400);
    await expect(invalidPathResponse.json()).resolves.toEqual({
      success: false,
      error: {
        code: "invalid_ref_arg"
      }
    });

    await rm(path.join(fixture.repoPath, ".git"), { recursive: true, force: true });

    const invalidResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/git/log?limit=1`
    );

    expect(invalidResponse.status).toBe(409);
    await expect(invalidResponse.json()).resolves.toEqual({
      success: false,
      error: {
        code: "workspace_not_bound",
        status: "invalid"
      }
    });
  });

  it("rejects git log limits outside the 1..100 contract", async () => {
    const { app } = await createTestContext();
    const fixture = await createFixtureRepo();
    tempDirectories.add(fixture.repoPath);
    const workspace = await createWorkspace(app, "workspace-files-log-limit");

    await fixture.write("README.md", "# fixture repo\n");
    await fixture.commitAll("initial commit");
    await bindWorkspaceRepo(app, workspace.workspace_id, fixture.repoPath);

    const response = await app.request(
      `/workspaces/${workspace.workspace_id}/git/log?limit=101`
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "invalid_ref_arg"
      }
    });
  });

  it("keeps diff and git-log routes mounted even when tool execution persistence is unavailable", async () => {
    const { app } = await createTestContext({
      includeToolExecutionRecordRepo: false
    });
    const workspace = await createWorkspace(app, "workspace-files-no-tool-records");

    const diffResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/files/diff?path=src/app.ts`
    );
    expect(diffResponse.status).toBe(409);

    const gitLogResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/git/log?limit=1&path=src/app.ts`
    );
    expect(gitLogResponse.status).toBe(409);
  });

  it("returns 429 for /files/diff when the per-workspace rate limit is exceeded", async () => {
    const fixture = await createFixtureRepo();
    tempDirectories.add(fixture.repoPath);

    const app = new Hono();
    const gitDiffService = {
      getFileDiff: vi.fn(async () => ({
        repoPath: fixture.repoPath,
        path: "src/app.ts",
        since: "HEAD",
        against: "working_tree",
        binary: false,
        deleted: false,
        added: false,
        unifiedDiff: "diff --git a/src/app.ts b/src/app.ts\n",
        truncated: false
      }))
    };

    registerWorkspaceFileRoutes(app, {
      workspaceService: {
        getById: async () => ({
          workspace_id: "workspace-rate-limit",
          root_path: "/tmp/workspace-rate-limit",
          repo_path: fixture.repoPath
        })
      },
      gitBindingValidation: {
        currentWorkingDirectory: process.cwd()
      },
      gitDiffService,
      gitRateLimiter: {
        allow: () => false
      }
    });

    const response = await app.request(
      "/workspaces/workspace-rate-limit/files/diff?path=src/app.ts"
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "rate_limited"
      }
    });
    expect(gitDiffService.getFileDiff).not.toHaveBeenCalled();
  });

  it("maps git command failures to 502 while preserving the existing diff failure code", async () => {
    const fixture = await createFixtureRepo();
    tempDirectories.add(fixture.repoPath);

    const app = new Hono();
    const gitDiffService = {
      getFileDiff: vi.fn(async () => {
        throw new GitCommandError("git command failed", "", "fatal: bad object HEAD");
      })
    };

    registerWorkspaceFileRoutes(app, {
      workspaceService: {
        getById: async () => ({
          workspace_id: "workspace-git-command-error",
          root_path: "/tmp/workspace-git-command-error",
          repo_path: fixture.repoPath
        })
      },
      gitBindingValidation: {
        currentWorkingDirectory: process.cwd()
      },
      gitDiffService
    });

    const response = await app.request(
      "/workspaces/workspace-git-command-error/files/diff?path=src/app.ts"
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "git_diff_failed"
      }
    });
  });

  it("uses the workspace git limiter for /git/log and avoids spawning the log service when limited", async () => {
    const fixture = await createFixtureRepo();
    tempDirectories.add(fixture.repoPath);

    const app = new Hono();
    const gitLogService = {
      listGitLog: vi.fn(async () => ({
        repoPath: fixture.repoPath,
        path: null,
        commits: [],
        truncated: false
      }))
    };
    const gitRateLimiter = {
      allow: vi.fn(() => false)
    };

    registerWorkspaceFileRoutes(app, {
      workspaceService: {
        getById: async () => ({
          workspace_id: "workspace-log-rate-limit",
          root_path: "/tmp/workspace-log-rate-limit",
          repo_path: fixture.repoPath
        })
      },
      gitBindingValidation: {
        currentWorkingDirectory: process.cwd()
      },
      gitLogService,
      gitRateLimiter
    });

    const response = await app.request(
      "/workspaces/workspace-log-rate-limit/git/log?limit=1"
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "rate_limited"
      }
    });
    expect(gitRateLimiter.allow).toHaveBeenCalledWith("workspace-log-rate-limit");
    expect(gitLogService.listGitLog).not.toHaveBeenCalled();
  });
});

async function createTestContext(options?: {
  readonly includeToolExecutionRecordRepo?: boolean;
}): Promise<TestContext> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const bootstrappingRecordRepo = new SqliteBootstrappingRecordRepo(database);
  const pathRelationRepo = new SqlitePathRelationRepo(database);
  const toolExecutionRecordRepo =
    options?.includeToolExecutionRecordRepo === false
      ? undefined
      : new SqliteToolExecutionRecordRepo(database);
  const toolSpecRepo = new SqliteToolSpecRepo(database);
  const workerRunRepo = new SqliteWorkerRunRepo(database);
  const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher,
    engineConfigRepo: workspaceEngineConfigRepo,
    bootstrappingPlanner: {
      planBootstrap: vi.fn(async (workspaceId: string) => ({
        relations: [],
        record: {
          record_id: `boot_${workspaceId}`,
          workspace_id: workspaceId,
          template_ids_used: [],
          paths_planted: 0,
          planted_at: "2026-04-23T00:00:00.000Z"
        }
      }))
    },
    pathRelationRepo,
    bootstrappingRecordRepo
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    bindingRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => true
  });
  const engineBindingService = new EngineBindingService({
    workspaceRepo,
    bindingRepo,
    eventPublisher,
    engineTester: {
      testBinding: async (binding) => ({
        provider_type: binding.provider,
        base_url: binding.base_url ?? null,
        model: binding.model,
        available_models: [binding.model]
      })
    }
  });
  await toolSpecRepo.insert({
    tool_id: "tools.write_file",
    category: "write",
    description: "Write a workspace file",
    scope_guard: "workspace",
    read_only: false,
    destructive: false,
    concurrency_safe: true,
    interrupt_behavior: "wait",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "best_effort",
    fast_path_eligible: false
  });

  return {
    app: createApp({
      workspaceService,
      workspaceGitBindingRepo: workspaceRepo,
      runService,
      conversationService: createNoopConversationService("workspace-files tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("workspace-files tests") as any,
      evidenceService: createUnusedEvidenceService("workspace-files tests") as any,
      memoryService: createUnusedMemoryService("workspace-files tests") as any,
      slotService: createUnusedSlotService("workspace-files tests") as any,
      surfaceService: createUnusedSurfaceService("workspace-files tests") as any,
      synthesisService: createUnusedSynthesisService("workspace-files tests") as any,
      claimService: createUnusedClaimService("workspace-files tests") as any,
      proposalService: createUnusedProposalService("workspace-files tests") as any,
      principalCodingEngineAvailable: true,
      toolExecutionRecordRepo,
      workerRunRepo,
      gitBindingValidation: {
        currentWorkingDirectory: process.cwd()
      }
    }),
    database,
    toolExecutionRecordRepo,
    workerRunRepo
  };
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string
): Promise<{ readonly workspace_id: string }> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  await configureWorkspacePrincipalCodingEngine(app, body.data.workspace_id);
  return body.data;
}

async function createRun(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  title: string
): Promise<{ readonly run_id: string }> {
  const response = await app.request(`/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      goal: "workspace-files test",
      run_mode: "chat"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data;
}

async function bindWorkspaceRepo(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  repoPath: string
): Promise<void> {
  const response = await app.request(`/workspaces/${workspaceId}/git-binding`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo_path: repoPath
    })
  });

  expect(response.status).toBe(200);
}

function createExecutionRecord(
  overrides: Partial<ToolExecutionRecord> & Pick<ToolExecutionRecord, "execution_id" | "requesting_run_id">
): ToolExecutionRecord {
  return {
    execution_id: overrides.execution_id,
    tool_id: overrides.tool_id ?? "tools.write_file",
    requested_by: overrides.requested_by ?? "principal",
    requesting_run_id: overrides.requesting_run_id,
    governance_decision_ref: overrides.governance_decision_ref ?? "gov-1",
    permission_result: overrides.permission_result ?? "allow",
    executed: overrides.executed ?? true,
    started_at: overrides.started_at ?? "2026-04-23T00:00:00.000Z",
    ended_at: overrides.ended_at ?? "2026-04-23T00:00:01.000Z",
    result_summary: overrides.result_summary ?? "ok",
    rollback_status: overrides.rollback_status ?? "none",
    post_effect_refs: overrides.post_effect_refs ?? [],
    affected_paths: overrides.affected_paths
  };
}

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: "worker-run-1",
    principal_run_id: "run-1",
    workspace_id: "workspace-1",
    requesting_run_id: "run-1",
    engine_class: "coding_engine",
    state: "active",
    subtask_description: "Inspect the current workspace diff state.",
    local_surface_ref: "surface://task/main",
    local_evidence_pointer: null,
    restricted_tool_set: ["read"],
    local_budget: {
      max_worker_delegations: 1,
      max_tool_calls: 4,
      max_output_tokens: 2048,
      max_wall_time_ms: 60000
    },
    agreed_return_format: {
      allowed_return_kinds: ["handoff"],
      requires_structured_summary: true
    },
    principal_security_snapshot: {
      governance_lease_ref: "lease-1",
      hard_constraint_refs: ["claim-1"],
      denied_tool_categories: ["network"]
    },
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}
