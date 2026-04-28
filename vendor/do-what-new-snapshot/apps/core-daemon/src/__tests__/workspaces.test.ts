import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import {
  Phase4BEventType,
  WorkspaceKind,
  parsePhase4BEventPayload,
  type BootstrappingRecord,
  type PathRelation
} from "@do-what/protocol";
import {
  EngineBindingService,
  EventPublisher,
  RunHotStateService,
  RunService,
  type SerialDelegationService,
  WorkspaceService
} from "@do-what/core";
import {
  buildBootstrappingPathId,
  buildBootstrappingRecordId
} from "@do-what/soul";
import {
  SqliteBootstrappingRecordRepo,
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { createUnusedClaimService, createUnusedEvidenceService, createUnusedMemoryService, createUnusedProposalService, createUnusedSignalService, createUnusedSlotService, createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";
import { SqliteWorkspaceEngineConfigRepo } from "../services/workspace-engine-config-repo.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly bindingRepo: SqliteEngineBindingRepo;
  readonly bootstrappingRecordRepo: SqliteBootstrappingRecordRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly pathRelationRepo: SqlitePathRelationRepo;
  readonly sseManager: SseManager;
  readonly workspaceRepo: SqliteWorkspaceRepo;
}

interface CreateTestContextOptions {
  readonly requestProtection?: {
    readonly allowedOrigin: string;
    readonly requestToken: string;
    readonly allowDesktopOriginlessRequests?: boolean;
  };
  readonly serialDelegationService?: Pick<SerialDelegationService, "dispatch">;
  readonly principalCodingEngineAvailable?: boolean;
  readonly failBootstrappingRecordCreate?: boolean;
  readonly failConversationEngineConfigAfterBindingUpsert?: boolean;
}

const databases = new Set<StorageDatabase>();
const tempDirectories = new Set<string>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirectories, async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
  tempDirectories.clear();
});

describe("workspace routes", () => {
  it("creates, lists, fetches, and deletes a workspace while recording lifecycle events", async () => {
    const { app, bootstrappingRecordRepo, eventLogRepo } = createTestContext();

    const createResponse = await app.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "alpha",
        root_path: "/tmp/alpha",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    });

    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as any;
    expect(createBody).toMatchObject({
      success: true,
      data: {
        name: "alpha",
        root_path: "/tmp/alpha",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        workspace_state: "active",
        default_engine_binding: null,
        archived_at: null
      }
    });
    expect(createBody.error).toBeUndefined();

    const workspaceId = createBody.data.workspace_id as string;
    expect(workspaceId.startsWith("ws_")).toBe(true);

    const listResponse = await app.request("/workspaces");
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as any;
    expect(listBody).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          workspace_id: workspaceId,
          name: "alpha"
        })
      ]
    });

    const getResponse = await app.request(`/workspaces/${workspaceId}`);
    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as any;
    expect(getBody).toMatchObject({
      success: true,
      data: {
        workspace_id: workspaceId,
        name: "alpha"
      }
    });

    const createEvents = await eventLogRepo.queryByEntity("workspace", workspaceId);
    expect(createEvents).toHaveLength(2);
    expect(createEvents.map((entry) => entry.event_type)).toEqual([
      "workspace.created",
      "bootstrapping.paths_planted"
    ]);
    expect(createEvents[0]).toMatchObject({
      event_type: "workspace.created",
      entity_id: workspaceId,
      workspace_id: workspaceId,
      run_id: null,
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        workspace_id: workspaceId,
        name: "alpha",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      }
    });

    const deleteResponse = await app.request(`/workspaces/${workspaceId}`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(200);
    const deleteBody = (await deleteResponse.json()) as any;
    expect(deleteBody).toMatchObject({
      success: true,
      data: {
        workspace_id: workspaceId,
        name: "alpha"
      }
    });

    const deletedGetResponse = await app.request(`/workspaces/${workspaceId}`);
    expect(deletedGetResponse.status).toBe(404);
    await expect(deletedGetResponse.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
    await expect(bootstrappingRecordRepo.findByWorkspace(workspaceId)).resolves.toBeNull();

    const allEvents = await eventLogRepo.queryByEntity("workspace", workspaceId);
    expect(allEvents.map((entry) => entry.event_type)).toEqual([
      "workspace.created",
      "bootstrapping.paths_planted",
      "workspace.deleted"
    ]);
  });

  it("bootstraps conservative learned paths during workspace creation", async () => {
    const { app, bootstrappingRecordRepo, eventLogRepo, pathRelationRepo } = createTestContext();

    const workspace = await createWorkspace(app, "bootstrapped-workspace");

    await expect(pathRelationRepo.findByWorkspace(workspace.workspace_id)).resolves.toEqual([
      expect.objectContaining({
        workspace_id: workspace.workspace_id,
        anchors: {
          source_anchor: {
            kind: "object",
            object_id: workspace.workspace_id
          },
          target_anchor: {
            kind: "object_facet",
            object_id: workspace.workspace_id,
            facet_key: "conservative_start"
          }
        },
        plasticity_state: expect.objectContaining({
          strength: 0.1,
          stability_class: "volatile"
        }),
        legitimacy: {
          evidence_basis: ["bootstrapping:workspace.bootstrap.conservative-start"],
          governance_class: "hint_only"
        },
        effect_vector: expect.objectContaining({
          default_manifestation_preference: "stance_bias"
        })
      })
    ]);
    await expect(bootstrappingRecordRepo.findByWorkspace(workspace.workspace_id)).resolves.toEqual(
      expect.objectContaining({
        workspace_id: workspace.workspace_id,
        paths_planted: 1,
        template_ids_used: ["workspace.bootstrap.conservative-start"]
      })
    );

    const workspaceEvents = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(workspaceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "workspace.created"
        }),
        expect.objectContaining({
          event_type: "bootstrapping.paths_planted",
          payload_json: expect.objectContaining({
            workspace_id: workspace.workspace_id,
            paths_planted: 1,
            template_ids: ["workspace.bootstrap.conservative-start"]
          })
        })
      ])
    );
  });

  it("fails closed without durable workspace/path leakage when bootstrapping record persistence fails", async () => {
    const { app, database, eventLogRepo } = createTestContext({
      failBootstrappingRecordCreate: true
    });

    const createResponse = await app.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bootstrap-failure",
        root_path: "/tmp/bootstrap-failure",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    });

    expect(createResponse.status).toBe(500);
    await expect(createResponse.json()).resolves.toMatchObject({
      success: false,
      error: "Internal server error"
    });

    const workspacePersisted =
      ((database.connection
        .prepare("SELECT COUNT(*) AS count FROM workspaces")
        .get() as { readonly count: number }).count ?? 0) > 0;
    const pathRelationsPersisted =
      (database.connection
        .prepare("SELECT COUNT(*) AS count FROM path_relations")
        .get() as { readonly count: number }).count ?? 0;
    const recordPersisted =
      ((database.connection
        .prepare("SELECT COUNT(*) AS count FROM bootstrapping_records")
        .get() as { readonly count: number }).count ?? 0) > 0;

    expect({
      workspacePersisted,
      pathRelationsPersisted,
      recordPersisted
    }).toEqual({
      workspacePersisted: false,
      pathRelationsPersisted: 0,
      recordPersisted: false
    });

    await expect(eventLogRepo.queryByType("workspace.created")).resolves.toEqual([]);
    await expect(eventLogRepo.queryByType("bootstrapping.paths_planted")).resolves.toEqual([]);
  });

  it("rejects invalid workspace payloads with a 400 envelope", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root_path: "/tmp/invalid",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request body"
    });
  });

  it("creates a workspace with a validated repo_path when provided", async () => {
    const { app } = createTestContext();
    const repoPath = await createGitBindingRepo();

    const response = await app.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "workspace-with-repo",
        root_path: "/tmp/workspace-with-repo",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        repo_path: repoPath
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        name: "workspace-with-repo",
        repo_path: repoPath
      }
    });
  });

  it("returns 404 for missing workspaces", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("rejects fresh run creation when no principal engine_class is configured", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "run-engine-config-required");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "unconfigured run",
        run_mode: "chat"
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });
  });

  it("returns 409 when deleting a workspace that still has runs", async () => {
    const { app } = createTestContext({
      principalCodingEngineAvailable: true
    });

    const workspace = await createWorkspace(app, "beta");

    const createRunResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "run one",
        goal: "protect workspace",
        run_mode: "chat",
        engine_class: "coding_engine"
      })
    });
    expect(createRunResponse.status).toBe(201);

    const deleteResponse = await app.request(`/workspaces/${workspace.workspace_id}`, {
      method: "DELETE"
    });

    expect(deleteResponse.status).toBe(409);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });
  });

  it("saves, reads, and tests a workspace engine binding through core-owned routes", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "engine-binding");

    const emptyResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding`);
    expect(emptyResponse.status).toBe(200);
    await expect(emptyResponse.json()).resolves.toMatchObject({
      success: true,
      data: null
    });

    const testResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_type: "custom",
        base_url: "https://proxy.example/v1",
        api_key: "sk-custom",
        model: "proxy-model",
        config: {}
      })
    });
    expect(testResponse.status).toBe(200);
    await expect(testResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        success: true,
        error: null,
        normalized_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v1",
          model: "proxy-model"
        }
      }
    });

    const saveResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_type: "custom",
        base_url: "https://proxy.example/v1",
        api_key: "sk-custom",
        model: "proxy-model",
        config: {}
      })
    });
    expect(saveResponse.status).toBe(200);
    const saveBody = (await saveResponse.json()) as any;
    expect(saveBody).toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        provider_type: "custom",
        base_url: "https://proxy.example/v1",
        model: "proxy-model"
      }
    });

    const readResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding`);
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        binding_id: saveBody.data.binding_id,
        workspace_id: workspace.workspace_id,
        provider_type: "custom",
        model: "proxy-model"
      }
    });

    const events = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(events.map((event) => event.event_type)).toContain("workspace.engine_binding.updated");
  });

  it("creates a fresh binding id for each workspace engine-binding update", async () => {
    const { app, bindingRepo } = createTestContext();
    const workspace = await createWorkspace(app, "engine-binding-versioned");

    const firstResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_type: "custom",
        base_url: "https://proxy.example/v1",
        api_key: "sk-custom-v1",
        model: "proxy-model-v1",
        config: {}
      })
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as any;
    const firstBindingId = firstBody.data.binding_id as string;

    const secondResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_type: "custom",
        base_url: "https://proxy.example/v1",
        api_key: "sk-custom-v2",
        model: "proxy-model-v2",
        config: {}
      })
    });
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as any;
    const secondBindingId = secondBody.data.binding_id as string;

    expect(secondBindingId).not.toBe(firstBindingId);

    await expect(bindingRepo.getById(firstBindingId)).resolves.toMatchObject({
      binding_id: firstBindingId,
      workspace_id: workspace.workspace_id,
      api_key: "sk-custom-v1",
      model: "proxy-model-v1"
    });
    await expect(bindingRepo.getById(secondBindingId)).resolves.toMatchObject({
      binding_id: secondBindingId,
      workspace_id: workspace.workspace_id,
      api_key: "sk-custom-v2",
      model: "proxy-model-v2"
    });

    const workspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`);
    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        default_engine_binding: secondBindingId
      }
    });
  });

  it("saves and reads a workspace git binding with live validation status", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "git-binding");
    const repoPath = await createGitBindingRepo();

    const saveResponse = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_path: repoPath
      })
    });

    expect(saveResponse.status).toBe(200);
    await expect(saveResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        repo_path: repoPath,
        status: "bound"
      }
    });

    const getResponse = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`);

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        repo_path: repoPath,
        status: "bound"
      }
    });
  });

  it("rejects invalid workspace git bindings with a structured 400 payload", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "git-binding-invalid");
    const notGitDirectory = await createTempDirectory("non-git-dir");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_path: notGitDirectory
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "not_a_git_repository",
        detail: expect.any(String)
      }
    });
  });

  it("rejects workspace git bindings whose .git file points outside the allowlist", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "git-binding-gitdir-escape");
    const repoPath = await createTempDirectory("gitdir-wrapper");
    const outsideRoot = await mkdtemp("/tmp/do-what-c30-outside-");
    const outsideGitDir = path.join(outsideRoot, "detached-gitdir");
    tempDirectories.add(outsideRoot);

    await mkdir(outsideGitDir, { recursive: true });
    await writeFile(path.join(repoPath, ".git"), `gitdir: ${outsideGitDir}\n`, "utf8");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_path: repoPath
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "outside_allowed_roots",
        detail: expect.any(String)
      }
    });
  });

  it("revalidates persisted git bindings on GET without mutating stored state", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "git-binding-drift");
    const repoPath = await createGitBindingRepo();

    const saveResponse = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_path: repoPath
      })
    });

    expect(saveResponse.status).toBe(200);

    await rm(path.join(repoPath, ".git"), { recursive: true, force: true });

    const getResponse = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`);

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        repo_path: repoPath,
        status: "invalid",
        reason: expect.any(String)
      }
    });
  });

  it("sanitizes stale git bindings from generic workspace GET responses", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "git-binding-generic-get");
    const repoPath = await createGitBindingRepo();

    const saveResponse = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_path: repoPath
      })
    });

    expect(saveResponse.status).toBe(200);

    await rm(path.join(repoPath, ".git"), { recursive: true, force: true });

    const workspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`);

    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        repo_path: null
      }
    });

    const bindingResponse = await app.request(`/workspaces/${workspace.workspace_id}/git-binding`);

    expect(bindingResponse.status).toBe(200);
    await expect(bindingResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        repo_path: repoPath,
        status: "invalid",
        reason: expect.any(String)
      }
    });
  });

  it("sanitizes stale git bindings from workspace list responses without masking valid bindings", async () => {
    const { app } = createTestContext();
    const validWorkspace = await createWorkspace(app, "git-binding-list-valid");
    const driftedWorkspace = await createWorkspace(app, "git-binding-list-drifted");
    const validRepoPath = await createGitBindingRepo();
    const driftedRepoPath = await createGitBindingRepo();

    const bindResponse = await Promise.all([
      app.request(`/workspaces/${validWorkspace.workspace_id}/git-binding`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo_path: validRepoPath
        })
      }),
      app.request(`/workspaces/${driftedWorkspace.workspace_id}/git-binding`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo_path: driftedRepoPath
        })
      })
    ]);

    expect(bindResponse.map((response) => response.status)).toEqual([200, 200]);

    await rm(path.join(driftedRepoPath, ".git"), { recursive: true, force: true });

    const response = await app.request("/workspaces");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          workspace_id: validWorkspace.workspace_id,
          repo_path: validRepoPath
        }),
        expect.objectContaining({
          workspace_id: driftedWorkspace.workspace_id,
          repo_path: null
        })
      ])
    });
  });

  it("returns workspace engine-config with truthful coding engine availability", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "engine-config");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        default_engine_class: null,
        conversation_binding: null,
        coding_engine_available: false
      }
    });
  });

  it("derives coding_engine_available from principal coding-path readiness instead of worker dispatch wiring", async () => {
    const { app } = createTestContext({
      serialDelegationService: {
        dispatch: async () => {
          throw new Error("not used by workspace route tests");
        }
      },
      principalCodingEngineAvailable: false
    });
    const workspace = await createWorkspace(app, "engine-config-principal-readiness");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        coding_engine_available: false
      }
    });
  });

  it("updates conversation_engine config by saving the binding and setting workspace default_engine_class", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "engine-config-conversation");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v1",
          api_key: "sk-custom",
          model: "proxy-model",
          config: {}
        }
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v1",
          model: "proxy-model"
        },
        coding_engine_available: false
      }
    });

    const workspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`);
    expect(workspaceResponse.status).toBe(200);
    const workspaceBody = (await workspaceResponse.json()) as any;
    expect(workspaceBody).toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        default_engine_class: "conversation_engine"
      }
    });
    const activeBindingId = workspaceBody.data.default_engine_binding as string;
    expect(typeof activeBindingId).toBe("string");

    const events = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "workspace.engine_binding.updated",
          payload_json: {
            workspace_id: workspace.workspace_id,
            binding_id: activeBindingId,
            provider_type: "custom",
            model: "proxy-model",
            base_url: "https://proxy.example/v1"
          }
        }),
        expect.objectContaining({
          event_type: "workspace.default_engine_class.updated",
          payload_json: {
            workspace_id: workspace.workspace_id,
            default_engine_class: "conversation_engine"
          }
        })
      ])
    );
  });

  it("creates a new binding version for each conversation engine-config update", async () => {
    const { app, bindingRepo } = createTestContext();
    const workspace = await createWorkspace(app, "engine-config-versioned");

    const firstConfig = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v1",
          api_key: "sk-config-v1",
          model: "proxy-config-v1",
          config: {}
        }
      })
    });
    expect(firstConfig.status).toBe(200);

    const firstWorkspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`);
    expect(firstWorkspaceResponse.status).toBe(200);
    const firstWorkspaceBody = (await firstWorkspaceResponse.json()) as any;
    const firstBindingId = firstWorkspaceBody.data.default_engine_binding as string;
    expect(typeof firstBindingId).toBe("string");

    const secondConfig = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v2",
          api_key: "sk-config-v2",
          model: "proxy-config-v2",
          config: {}
        }
      })
    });
    expect(secondConfig.status).toBe(200);

    const secondWorkspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`);
    expect(secondWorkspaceResponse.status).toBe(200);
    const secondWorkspaceBody = (await secondWorkspaceResponse.json()) as any;
    const secondBindingId = secondWorkspaceBody.data.default_engine_binding as string;

    expect(secondBindingId).not.toBe(firstBindingId);
    await expect(bindingRepo.getById(firstBindingId)).resolves.toMatchObject({
      binding_id: firstBindingId,
      workspace_id: workspace.workspace_id,
      model: "proxy-config-v1"
    });
    await expect(bindingRepo.getById(secondBindingId)).resolves.toMatchObject({
      binding_id: secondBindingId,
      workspace_id: workspace.workspace_id,
      model: "proxy-config-v2"
    });
  });

  it("does not overwrite a foreign binding row when workspace default_engine_binding is stale", async () => {
    const { app, database, bindingRepo } = createTestContext();
    const workspaceA = await createWorkspace(app, "engine-config-foreign-a");
    const workspaceB = await createWorkspace(app, "engine-config-foreign-b");

    const workspaceBBindingResponse = await app.request(`/workspaces/${workspaceB.workspace_id}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_type: "custom",
        base_url: "https://proxy.workspace-b/v1",
        api_key: "sk-workspace-b",
        model: "workspace-b-model",
        config: {}
      })
    });
    expect(workspaceBBindingResponse.status).toBe(200);
    const workspaceBBindingBody = (await workspaceBBindingResponse.json()) as any;
    const foreignBindingId = workspaceBBindingBody.data.binding_id as string;

    database.connection
      .prepare("UPDATE workspaces SET default_engine_binding = ?, default_engine_class = 'conversation_engine' WHERE workspace_id = ?")
      .run(foreignBindingId, workspaceA.workspace_id);

    const response = await app.request(`/workspaces/${workspaceA.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.workspace-a/v1",
          api_key: "sk-workspace-a",
          model: "workspace-a-model",
          config: {}
        }
      })
    });

    expect(response.status).toBe(200);

    const workspaceAResponse = await app.request(`/workspaces/${workspaceA.workspace_id}`);
    expect(workspaceAResponse.status).toBe(200);
    const workspaceABody = (await workspaceAResponse.json()) as any;
    const workspaceABindingId = workspaceABody.data.default_engine_binding as string;

    expect(workspaceABindingId).not.toBe(foreignBindingId);
    await expect(bindingRepo.getById(foreignBindingId)).resolves.toMatchObject({
      binding_id: foreignBindingId,
      workspace_id: workspaceB.workspace_id,
      model: "workspace-b-model"
    });
    await expect(bindingRepo.getById(workspaceABindingId)).resolves.toMatchObject({
      binding_id: workspaceABindingId,
      workspace_id: workspaceA.workspace_id,
      model: "workspace-a-model"
    });
  });

  it("fails closed without partial writes when atomic conversation engine-config persistence fails", async () => {
    const { app, eventLogRepo } = createTestContext({
      failConversationEngineConfigAfterBindingUpsert: true
    });
    const workspace = await createWorkspace(app, "engine-config-atomic-failure");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v1",
          api_key: "sk-custom",
          model: "proxy-model",
          config: {}
        }
      })
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Internal server error"
    });

    const workspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`);
    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        default_engine_class: null,
        default_engine_binding: null
      }
    });

    const bindingResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding`);
    expect(bindingResponse.status).toBe(200);
    await expect(bindingResponse.json()).resolves.toMatchObject({
      success: true,
      data: null
    });

    const events = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(events.map((event) => event.event_type)).toEqual([
      "workspace.created",
      "bootstrapping.paths_planted"
    ]);
  });

  it("accepts conversation_engine config without an inline binding when a workspace binding already exists", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "engine-config-existing-binding");

    const bindingResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-binding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider_type: "openai",
        base_url: null,
        api_key: "sk-openai",
        model: "gpt-4o-mini",
        config: {}
      })
    });
    expect(bindingResponse.status).toBe(200);

    const response = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "openai",
          model: "gpt-4o-mini"
        }
      }
    });
  });

  it("updates coding_engine config without requiring a conversation binding payload", async () => {
    const { app, eventLogRepo } = createTestContext({
      principalCodingEngineAvailable: true
    });
    const workspace = await createWorkspace(app, "engine-config-coding");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "coding_engine"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        default_engine_class: "coding_engine",
        conversation_binding: null,
        coding_engine_available: true
      }
    });

    const events = await eventLogRepo.queryByEntity("workspace", workspace.workspace_id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "workspace.default_engine_class.updated",
          payload_json: {
            workspace_id: workspace.workspace_id,
            default_engine_class: "coding_engine"
          }
        })
      ])
    );
  });

  it("rejects coding_engine config updates when coding engine is unavailable", async () => {
    const { app } = createTestContext({
      principalCodingEngineAvailable: false
    });
    const workspace = await createWorkspace(app, "engine-config-coding-unavailable");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "coding_engine"
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });
  });

  it("streams workspace-scoped events over SSE", async () => {
    const { app, eventLogRepo, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "workspace-sse");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const stream = createSseClient(response);
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 1);

    // soul.* events are Phase0.5 — not in Phase0EventSchema, so they cannot go through
    // EventPublisher.publish(). Use the lower-level append + broadcastEntry instead.
    const emitted = await eventLogRepo.append({
      event_type: "soul.slot.created",
      entity_type: "slot",
      entity_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: workspace.workspace_id,
      run_id: null,
      caused_by: "system",
      revision: 0,
      payload_json: {
        object_id: "11111111-1111-4111-8111-111111111111",
        object_kind: "slot",
        workspace_id: workspace.workspace_id,
        run_id: null,
        governance_subject: {
          subject_domain: "security",
          subject_qualifiers: {
            category: "secrets"
          },
          canonical_key: "security::category=secrets"
        },
        claim_kind: "constraint",
        scope_class: "project",
        winner_claim_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }
    });
    await sseManager.broadcastEntry(emitted);

    const firstEvent = await stream.readEvent();
    let pushed = firstEvent;

    if (firstEvent.event === "connected") {
      expect(firstEvent.data.workspace_id).toBe(workspace.workspace_id);
      pushed = await stream.readEvent();
    }

    expect(pushed.id).toBe(emitted.event_id);
    expect(pushed.event).toBe("soul.slot.created");

    await stream.close();
    // Normal client disconnect is silently swallowed; verify cleanup via connectionCount.
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
    expect(sseManager.connectionCount(undefined, workspace.workspace_id)).toBe(0);
  });

  it("streams bootstrapping.paths_planted over workspace SSE during workspace creation", async () => {
    const workspaceCreatedSignal = createDeferred<string>();
    const allowCreateToFinish = createDeferred<void>();
    const { app, sseManager, workspaceRepo } = createTestContext();
    const originalWorkspaceCreate = workspaceRepo.create.bind(workspaceRepo);
    const createSpy = vi.spyOn(workspaceRepo, "create").mockImplementation(async (input) => {
      const createdWorkspace = await originalWorkspaceCreate(input);
      workspaceCreatedSignal.resolve(createdWorkspace.workspace_id);
      await allowCreateToFinish.promise;
      return createdWorkspace;
    });

    let responsePromise: Promise<Response> | null = null;
    let stream: SseTestClient | null = null;
    let workspaceId: string | null = null;

    try {
      const createResponsePromise = app.request("/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "workspace-sse-bootstrapping",
          root_path: "/tmp/workspace-sse-bootstrapping",
          workspace_kind: WorkspaceKind.LOCAL_REPO
        })
      });

      workspaceId = await workspaceCreatedSignal.promise;
      responsePromise = app.request(`/workspaces/${workspaceId}/events`);
      await waitForCondition(() => sseManager.connectionCount(undefined, workspaceId!) === 1);

      allowCreateToFinish.resolve();

      const createResponse = await createResponsePromise;
      expect(createResponse.status).toBe(201);
      await expect(createResponse.json()).resolves.toMatchObject({
        success: true,
        data: {
          workspace_id: workspaceId,
          name: "workspace-sse-bootstrapping"
        }
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      stream = createSseClient(response);

      const connected = await stream.readEvent();
      expect(connected.event).toBe("connected");
      expect(connected.data).toMatchObject({
        workspace_id: workspaceId,
        last_event_id: expect.any(String)
      });

      const workspaceCreatedEvent = await stream.readEvent();
      expect(workspaceCreatedEvent.event).toBe("workspace.created");
      expect(workspaceCreatedEvent.data).toMatchObject({
        workspace_id: workspaceId,
        name: "workspace-sse-bootstrapping",
        workspace_kind: WorkspaceKind.LOCAL_REPO
      });

      const bootstrappingPathsPlanted = await stream.readEvent();
      expect(bootstrappingPathsPlanted.event).toBe("bootstrapping.paths_planted");
      expect(bootstrappingPathsPlanted.data).toMatchObject({
        workspace_id: workspaceId,
        paths_planted: 1,
        template_ids: ["workspace.bootstrap.conservative-start"]
      });
    } finally {
      allowCreateToFinish.resolve();

      if (stream !== null) {
        await stream.close().catch(() => undefined);
      } else if (responsePromise !== null) {
        const response = await responsePromise.catch(() => null);
        if (response?.body !== null && response !== null) {
          await createSseClient(response).close().catch(() => undefined);
        }
      }

      createSpy.mockRestore();
      if (workspaceId !== null) {
        const workspaceIdForCleanup = workspaceId;
        await waitForCondition(() => sseManager.connectionCount(undefined, workspaceIdForCleanup) === 0);
      }
    }
  });

  it("broadcasts workspace.default_engine_class.updated over workspace SSE when engine config changes", async () => {
    const { app, sseManager } = createTestContext({
      principalCodingEngineAvailable: true
    });
    const workspace = await createWorkspace(app, "workspace-engine-class-sse");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const stream = createSseClient(response);
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 1);

    const firstEvent = await stream.readEvent();
    expect(firstEvent.event).toBe("connected");

    const updateResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "coding_engine"
      })
    });
    expect(updateResponse.status).toBe(200);

    const pushed = await stream.readEvent();
    expect(pushed.event).toBe("workspace.default_engine_class.updated");
    expect(pushed.data).toMatchObject({
      workspace_id: workspace.workspace_id,
      default_engine_class: "coding_engine"
    });

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
    expect(sseManager.connectionCount(undefined, workspace.workspace_id)).toBe(0);
  });

  it("broadcasts workspace.engine_binding.updated and workspace.default_engine_class.updated over workspace SSE for conversation engine-config updates", async () => {
    const { app, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "workspace-engine-config-conversation-sse");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const stream = createSseClient(response);
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 1);

    const firstEvent = await stream.readEvent();
    expect(firstEvent.event).toBe("connected");

    const updateResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v1",
          api_key: "sk-custom",
          model: "proxy-model",
          config: {}
        }
      })
    });
    expect(updateResponse.status).toBe(200);

    const bindingUpdated = await stream.readEvent();
    const defaultEngineClassUpdated = await stream.readEvent();

    expect(bindingUpdated.event).toBe("workspace.engine_binding.updated");
    expect(bindingUpdated.data).toMatchObject({
      workspace_id: workspace.workspace_id,
      provider_type: "custom",
      base_url: "https://proxy.example/v1",
      model: "proxy-model"
    });
    expect(typeof bindingUpdated.data.binding_id).toBe("string");

    expect(defaultEngineClassUpdated.event).toBe("workspace.default_engine_class.updated");
    expect(defaultEngineClassUpdated.data).toMatchObject({
      workspace_id: workspace.workspace_id,
      default_engine_class: "conversation_engine"
    });

    const workspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`);
    expect(workspaceResponse.status).toBe(200);
    const workspaceBody = (await workspaceResponse.json()) as any;
    expect(workspaceBody.data.default_engine_binding).toBe(bindingUpdated.data.binding_id);

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
    expect(sseManager.connectionCount(undefined, workspace.workspace_id)).toBe(0);
  });

  it("does not emit a CORS allow-origin header for null-origin SSE requests", async () => {
    const { app } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });
    const workspace = await createWorkspace(app, "workspace-desktop-sse", {
      origin: "http://localhost:5173",
      "x-request-token": "request-token-123"
    });

    const response = await app.request(`/workspaces/${workspace.workspace_id}/events?desktop=1`, {
      headers: {
        origin: "null"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("replays missed workspace events after reconnecting from an initially empty stream", async () => {
    const { app, eventPublisher, sseManager } = createTestContext({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "request-token-123"
      }
    });
    const workspace = await createWorkspace(app, "workspace-empty-replay", {
      origin: "http://localhost:5173",
      "x-request-token": "request-token-123"
    });

    const firstConn = createSseClient(await app.request(`/workspaces/${workspace.workspace_id}/events`));
    const connectedFirst = await firstConn.readEvent();
    expect(connectedFirst.event).toBe("connected");
    expect(connectedFirst.id).not.toBe("");
    await firstConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);

    const missedEvent = await eventPublisher.publish({
      event_type: "soul.slot.created",
      entity_type: "slot",
      entity_id: "slot-empty-replay",
      workspace_id: workspace.workspace_id,
      run_id: null,
      caused_by: "system",
      revision: 0,
      payload_json: {
        object_id: "slot-empty-replay",
        object_kind: "slot",
        workspace_id: workspace.workspace_id,
        run_id: null,
        governance_subject: {
          subject_domain: "security",
          subject_qualifiers: {
            category: "replay"
          },
          canonical_key: "security::category=replay"
        },
        claim_kind: "constraint",
        scope_class: "project",
        winner_claim_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }
    });

    const secondConn = createSseClient(
      await app.request(`/workspaces/${workspace.workspace_id}/events`, {
        headers: {
          "Last-Event-ID": connectedFirst.id
        }
      })
    );
    const connectedSecond = await secondConn.readEvent();
    expect(connectedSecond.event).toBe("connected");
    expect(connectedSecond.id).toBe("");

    const replayed = await secondConn.readEvent();
    expect(replayed.id).toBe(missedEvent.event_id);

    await secondConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

  it("does not replay soul.graph.explore_completed over workspace SSE reconnect", async () => {
    const { app, eventLogRepo, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "workspace-query-audit-filter");

    const firstConn = createSseClient(await app.request(`/workspaces/${workspace.workspace_id}/events`));
    const connectedFirst = await firstConn.readEvent();
    expect(connectedFirst.event).toBe("connected");
    expect(connectedFirst.id).not.toBe("");
    await firstConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);

    await eventLogRepo.append({
      event_type: Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "workspace",
      entity_id: workspace.workspace_id,
      workspace_id: workspace.workspace_id,
      run_id: null,
      caused_by: "system",
      payload_json: parsePhase4BEventPayload(Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED, {
        exploration_kind: "path_topology",
        workspace_id: workspace.workspace_id,
        total_nodes: 3,
        total_edges: 2,
        strongly_connected_components: 2,
        occurred_at: "2026-04-21T08:00:00.000Z"
      })
    });

    const secondConn = createSseClient(
      await app.request(`/workspaces/${workspace.workspace_id}/events`, {
        headers: {
          "Last-Event-ID": connectedFirst.id
        }
      })
    );
    const connectedSecond = await secondConn.readEvent();
    expect(connectedSecond.event).toBe("connected");
    expect(connectedSecond.id).toBe("");
    await expect(secondConn.readEvent(200)).rejects.toThrow(/Timed out/);

    await secondConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

  it("seeds fresh workspace SSE cursors from the latest visible event when topology audits are filtered", async () => {
    const { app, eventLogRepo, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "workspace-visible-cursor-seed");

    const baselineConn = createSseClient(await app.request(`/workspaces/${workspace.workspace_id}/events`));
    const baselineConnected = await baselineConn.readEvent();
    expect(baselineConnected.event).toBe("connected");
    expect(baselineConnected.id).not.toBe("");
    await baselineConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);

    const hiddenAudit = await eventLogRepo.append({
      event_type: Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "workspace",
      entity_id: workspace.workspace_id,
      workspace_id: workspace.workspace_id,
      run_id: null,
      caused_by: "system",
      payload_json: parsePhase4BEventPayload(Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED, {
        exploration_kind: "path_topology",
        workspace_id: workspace.workspace_id,
        total_nodes: 3,
        total_edges: 2,
        strongly_connected_components: 2,
        occurred_at: "2026-04-21T08:00:00.000Z"
      })
    });

    const freshConn = createSseClient(await app.request(`/workspaces/${workspace.workspace_id}/events`));
    const freshConnected = await freshConn.readEvent();
    expect(freshConnected.event).toBe("connected");
    expect(freshConnected.id).toBe(baselineConnected.id);
    expect(freshConnected.data.last_event_id).toBe(baselineConnected.id);
    expect(freshConnected.id).not.toBe(hiddenAudit.event_id);

    await expect(freshConn.readEvent(200)).rejects.toThrow(/Timed out/);

    await freshConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

  it("still replays memory-neighbor explore events over workspace SSE reconnect", async () => {
    const { app, eventLogRepo, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "workspace-memory-neighbor-replay");

    const firstConn = createSseClient(await app.request(`/workspaces/${workspace.workspace_id}/events`));
    const connectedFirst = await firstConn.readEvent();
    expect(connectedFirst.event).toBe("connected");
    expect(connectedFirst.id).not.toBe("");
    await firstConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);

    const replayable = await eventLogRepo.append({
      event_type: Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "memory_entry",
      entity_id: "memory-1",
      workspace_id: workspace.workspace_id,
      run_id: null,
      caused_by: "system",
      payload_json: parsePhase4BEventPayload(Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED, {
        exploration_kind: "memory_neighbors",
        source_memory_id: "memory-1",
        workspace_id: workspace.workspace_id,
        direction: "both",
        neighbor_count: 2,
        occurred_at: "2026-04-21T08:00:00.000Z"
      })
    });

    const secondConn = createSseClient(
      await app.request(`/workspaces/${workspace.workspace_id}/events`, {
        headers: {
          "Last-Event-ID": connectedFirst.id
        }
      })
    );
    const connectedSecond = await secondConn.readEvent();
    expect(connectedSecond.event).toBe("connected");
    expect(connectedSecond.id).toBe("");

    const replayed = await secondConn.readEvent();
    expect(replayed.event).toBe(Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED);
    expect(replayed.id).toBe(replayable.event_id);
    expect(replayed.data).toMatchObject({
      exploration_kind: "memory_neighbors",
      source_memory_id: "memory-1",
      workspace_id: workspace.workspace_id,
      direction: "both",
      neighbor_count: 2
    });

    await secondConn.close();
    await waitForCondition(() => sseManager.connectionCount(undefined, workspace.workspace_id) === 0);
  });

});

function createTestContext(options?: CreateTestContextOptions): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const bootstrappingRecordRepo = new SqliteBootstrappingRecordRepo(database);
  const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(database, {
    onAfterBindingUpsert: options?.failConversationEngineConfigAfterBindingUpsert
      ? () => {
          throw new Error("simulated-conversation-engine-config-transaction-failure");
        }
      : undefined
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const pathRelationRepo = new SqlitePathRelationRepo(database);
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
        relations: [createBootstrappedPathRelation(workspaceId)],
        record: createBootstrappingRecord(workspaceId)
      }))
    },
    pathRelationRepo,
    bootstrappingRecordRepo: options?.failBootstrappingRecordCreate
      ? {
          findByWorkspace: async (workspaceId: string) =>
            await bootstrappingRecordRepo.findByWorkspace(workspaceId),
          create: async () => {
            throw new Error("simulated-bootstrapping-record-create-failure");
          }
        }
      : bootstrappingRecordRepo
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    bindingRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => options?.principalCodingEngineAvailable ?? false
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
  const conversationService = {
    sendMessage: async () => {
      throw new Error("Conversation route not used in workspace tests");
    }
  };

  return {
    app: createApp({
      workspaceService,
      workspaceGitBindingRepo: workspaceRepo,
      runService,
      conversationService: conversationService as any,
      engineBindingService,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("workspace tests") as any,
      evidenceService: createUnusedEvidenceService("workspace tests") as any,
      memoryService: createUnusedMemoryService("workspace tests") as any,
      slotService: createUnusedSlotService("workspace tests") as any,
      surfaceService: createUnusedSurfaceService("workspace tests") as any,
      synthesisService: createUnusedSynthesisService("workspace tests") as any,
      claimService: createUnusedClaimService("workspace tests") as any,
      proposalService: createUnusedProposalService("workspace tests") as any,
      serialDelegationService: options?.serialDelegationService,
      principalCodingEngineAvailable: options?.principalCodingEngineAvailable,
      requestProtection: options?.requestProtection
    }),
    database,
    bindingRepo,
    bootstrappingRecordRepo,
    eventLogRepo,
    eventPublisher,
    pathRelationRepo,
    sseManager,
    workspaceRepo
  };
}

async function createWorkspace(app: ReturnType<typeof createApp>, name: string): Promise<{
  readonly workspace_id: string;
}>;
async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string,
  headers: Record<string, string> = {}
): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data;
}

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(process.cwd(), `.tmp-c30-${prefix}-`));
  tempDirectories.add(directory);
  return directory;
}

async function createGitBindingRepo(): Promise<string> {
  const repoPath = await createTempDirectory("repo");
  await mkdir(path.join(repoPath, ".git"), { recursive: true });
  return repoPath;
}

function createBootstrappedPathRelation(workspaceId: string): PathRelation {
  return {
    path_id: buildBootstrappingPathId(workspaceId, "workspace.bootstrap.conservative-start"),
    workspace_id: workspaceId,
    anchors: {
      source_anchor: {
        kind: "object",
        object_id: workspaceId
      },
      target_anchor: {
        kind: "object_facet",
        object_id: workspaceId,
        facet_key: "conservative_start"
      }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["new workspace starts with conservative learned-path defaults"]
    },
    effect_vector: {
      salience: 0.1,
      recall_bias: 0,
      verification_bias: 0.1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.1,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: {
      retirement_rule: "consolidation_only"
    },
    legitimacy: {
      evidence_basis: ["bootstrapping:workspace.bootstrap.conservative-start"],
      governance_class: "hint_only"
    },
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z"
  };
}

function createBootstrappingRecord(workspaceId: string): BootstrappingRecord {
  return {
    record_id: buildBootstrappingRecordId(workspaceId),
    workspace_id: workspaceId,
    paths_planted: 1,
    template_ids_used: ["workspace.bootstrap.conservative-start"],
    planted_at: "2026-04-20T00:00:00.000Z"
  };
}





interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: any;
}

function createSseClient(response: Response): SseTestClient {
  if (response.body === null) {
    throw new Error("Expected SSE response body");
  }

  return new SseTestClient(response.body.getReader());
}

class SseTestClient {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  public constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  public async readEvent(timeoutMs = 2000): Promise<ParsedSseEvent> {
    while (true) {
      const delimiter = this.buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const frame = this.buffer.slice(0, delimiter);
        this.buffer = this.buffer.slice(delimiter + 2);
        return parseSseFrame(frame);
      }

      const chunk = await readWithTimeout(this.reader, timeoutMs);
      if (chunk.done) {
        throw new Error("SSE stream closed before next event");
      }

      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  public async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for SSE chunk after ${timeoutMs}ms`));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseSseFrame(frame: string): ParsedSseEvent {
  let id = "";
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const dataText = dataLines.join("\n");

  return {
    id,
    event,
    data: dataText.length === 0 ? null : JSON.parse(dataText)
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve
  };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
