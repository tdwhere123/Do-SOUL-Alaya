import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  DYNAMICS_CONSTANTS,
  HealthEventKind,
  GardenEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteConfigRepo,
  SqliteEventLogRepo,
  type ConfigRepo
} from "@do-soul/alaya-storage";
import { registerConfigRoutes } from "../../routes/config.js";
import { createConfigService } from "../../services/config-service.js";
import { applyRuntimeEmbeddingConfigFiles } from "../../services/env-file-service.js";
import { resolveAlayaConfigPaths, type AlayaConfigPaths } from "../../cli/config-files.js";

describe("routes-config port batch", () => {
  it("forwards runtime embedding patch fields without dropping embedding_enabled", async () => {
    const configService = {
      getSoulConfig: vi.fn(),
      patchSoulConfig: vi.fn(),
      getStrategyConfig: vi.fn(),
      patchStrategyConfig: vi.fn(),
      getEnvironmentConfig: vi.fn(),
      patchEnvironmentConfig: vi.fn(),
      getRuntimeEmbeddingConfig: vi.fn(),
      patchRuntimeEmbeddingConfig: vi.fn(async (patch: unknown) => patch),
      getGardenCredentialProvenance: vi.fn(async () => ({ kind: "none" }))
    };
    const app = new Hono();
    registerConfigRoutes(app, {
      workspaceService: { getById: vi.fn() },
      configService
    } as any);

    const body = {
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    };
    const response = await app.request("/config/runtime/embedding-supplement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: body,
      requires_daemon_restart: true
    });
    expect(configService.patchRuntimeEmbeddingConfig).toHaveBeenCalledWith(body);
  });

  it("reports runtime Garden compute patches as hot-applied without daemon restart", async () => {
    const configService = {
      getSoulConfig: vi.fn(),
      patchSoulConfig: vi.fn(),
      getStrategyConfig: vi.fn(),
      patchStrategyConfig: vi.fn(),
      getEnvironmentConfig: vi.fn(),
      patchEnvironmentConfig: vi.fn(),
      getRuntimeEmbeddingConfig: vi.fn(),
      patchRuntimeEmbeddingConfig: vi.fn(),
      getRuntimeGardenComputeConfig: vi.fn(),
      patchRuntimeGardenComputeConfig: vi.fn(async (patch: unknown) => patch),
      getGardenCredentialProvenance: vi.fn(async () => ({ kind: "none" }))
    };
    const app = new Hono();
    registerConfigRoutes(app, {
      workspaceService: { getById: vi.fn() },
      configService
    } as any);

    const body = {
      provider_kind: "official_api",
      provider_url: null,
      secret_ref: "env:ALAYA_TEST_OPENAI_KEY",
      model_id: "gpt-4.1-mini",
      enabled: true
    };
    const response = await app.request("/config/runtime/garden-compute", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: body,
      requires_daemon_restart: false
    });
    expect(configService.patchRuntimeGardenComputeConfig).toHaveBeenCalledWith(body);
  });

  it("reads and patches workspace manifestation budget config through the config service and EventLog audit", async () => {
    const harness = await createServiceHarness();
    const app = new Hono();
    registerConfigRoutes(app, {
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-budget" })) },
      configService: harness.service
    } as any);

    const initial = await app.request("/workspaces/ws-budget/config/manifestation-budget");
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      success: true,
      source: "default",
      data: {
        workspace_id: "ws-budget",
        stance_bias_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_stance_bias_cap,
        dialogue_nudge_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_dialogue_nudge_cap,
        lens_entry_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_entry_cap
      }
    });
    expect(harness.publishedEvents).toHaveLength(0);

    const patch = await app.request("/workspaces/ws-budget/config/manifestation-budget", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stance_bias_cap: 7,
        escalation_policy: {
          nudge_min_pressure: 0.45
        }
      })
    });

    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      success: true,
      requires_daemon_restart: false,
      data: {
        workspace_id: "ws-budget",
        stance_bias_cap: 7,
        escalation_policy: {
          nudge_min_pressure: 0.45,
          lens_requires_task_coupling: true
        }
      }
    });
    expect(harness.publishedEvents).toHaveLength(1);
    expect(harness.publishedEvents[0]).toMatchObject({
      event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      entity_type: "workspace_config",
      entity_id: "workspace:ws-budget:manifestation_budget",
      workspace_id: "ws-budget",
      caused_by: "inspector",
      payload_json: {
        entry_id: "audit-1",
        event_kind: HealthEventKind.RECALL_TUNING,
        workspace_id: "ws-budget",
        change_summary: {
          fields_changed: ["stance_bias_cap", "escalation_policy.nudge_min_pressure"]
        }
      }
    });

    const stored = await app.request("/workspaces/ws-budget/config/manifestation-budget");
    await expect(stored.json()).resolves.toMatchObject({
      success: true,
      source: "stored",
      data: {
        workspace_id: "ws-budget",
        stance_bias_cap: 7,
        escalation_policy: {
          nudge_min_pressure: 0.45
        }
      }
    });
  });

  it("rejects non-object manifestation budget patches before EventLog mutation", async () => {
    const harness = await createServiceHarness();

    await expect(
      harness.service.patchManifestationBudgetConfig("ws-budget", [])
    ).rejects.toThrow("Invalid manifestation budget config patch");
    await expect(
      harness.service.patchManifestationBudgetConfig("ws-budget", {
        escalation_policy: []
      })
    ).rejects.toThrow("Invalid manifestation budget config patch");
    expect(harness.appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("persists runtime embedding config through the config service envelope and EventLog audit", async () => {
    const harness = await createServiceHarness();

    await harness.service.patchRuntimeEmbeddingConfig({
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    });

    await expect(harness.service.getRuntimeEmbeddingConfig()).resolves.toEqual({
      config_version: 1,
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    });
    expect(harness.publishedEvents).toHaveLength(1);
    expect(harness.publishedEvents[0]).toMatchObject({
      event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      entity_type: "runtime_config",
      entity_id: "runtime:embedding-supplement",
      caused_by: "inspector",
      payload_json: {
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        change_summary: {
          fields_changed: ["provider_url", "secret_ref", "model_id", "embedding_enabled"],
          secret_ref_kind: "env"
        }
      }
    });
  });

  it("records the non-secret provider_url and model_id in the runtime Garden compute config audit", async () => {
    const harness = await createServiceHarness();

    await harness.service.patchRuntimeGardenComputeConfig({
      provider_kind: "official_api",
      provider_url: "https://garden.example.test/v1",
      secret_ref: "env:ALAYA_TEST_GARDEN_KEY",
      model_id: "gpt-4.1-mini",
      enabled: true
    });

    expect(harness.publishedEvents).toHaveLength(1);
    expect(harness.publishedEvents[0]).toMatchObject({
      event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      entity_type: "runtime_config",
      entity_id: "runtime:garden-compute",
      caused_by: "inspector",
      payload_json: {
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        change_summary: {
          fields_changed: ["provider_kind", "provider_url", "secret_ref", "model_id", "enabled"],
          secret_ref_kind: "env",
          provider_url: "https://garden.example.test/v1",
          model_id: "gpt-4.1-mini"
        }
      }
    });
  });

  it("normalizes keychain refs through env-file and audit provenance surfaces", async () => {
    const harness = await createServiceHarness();

    await harness.service.patchRuntimeGardenComputeConfig({
      provider_kind: "official_api",
      provider_url: null,
      secret_ref: "keychain:alaya-garden:openai",
      model_id: "gpt-4.1-mini",
      enabled: true
    });

    await expect(harness.service.getRuntimeGardenComputeConfig()).resolves.toMatchObject({
      config_version: 1,
      secret_ref: "keychain:alaya-garden:openai"
    });
    await expect(readFile(harness.paths.envPath, "utf8")).resolves.toContain(
      "ALAYA_OFFICIAL_GARDEN_SECRET_REF=keychain:alaya-garden:openai"
    );
    expect(harness.publishedEvents[0]).toMatchObject({
      payload_json: {
        change_summary: {
          fields_changed: ["provider_kind", "provider_url", "secret_ref", "model_id", "enabled"],
          secret_ref_kind: "keychain"
        }
      }
    });
    await expect(harness.service.getGardenCredentialProvenance()).resolves.toEqual({ kind: "keychain" });
  });

  it("persists provider_kind=host_worker and mirrors it into ALAYA_GARDEN_PROVIDER_KIND", async () => {
    const harness = await createServiceHarness();

    await harness.service.patchRuntimeGardenComputeConfig({
      provider_kind: "host_worker",
      provider_url: null,
      secret_ref: null,
      model_id: null,
      enabled: false
    });

    await expect(harness.service.getRuntimeGardenComputeConfig()).resolves.toMatchObject({
      config_version: 1,
      provider_kind: "host_worker",
      secret_ref: null
    });
    await expect(readFile(harness.paths.envPath, "utf8")).resolves.toContain(
      "ALAYA_GARDEN_PROVIDER_KIND=host_worker"
    );
    expect(harness.publishedEvents[0]).toMatchObject({
      payload_json: {
        change_summary: {
          fields_changed: ["provider_kind", "provider_url", "secret_ref", "model_id", "enabled"]
        }
      }
    });
  });

  it("derives provider_kind from ALAYA_GARDEN_PROVIDER_KIND when no persisted Garden config row exists", async () => {
    const harness = await createServiceHarness();
    await writeFile(harness.paths.envPath, "ALAYA_GARDEN_PROVIDER_KIND=host_worker\n", "utf8");

    await expect(harness.service.getRuntimeGardenComputeConfig()).resolves.toMatchObject({
      config_version: 1,
      provider_kind: "host_worker",
      enabled: false
    });
  });

  it("ignores an unrecognized ALAYA_GARDEN_PROVIDER_KIND and falls back to the host_worker no-secret default", async () => {
    const harness = await createServiceHarness();
    await writeFile(harness.paths.envPath, "ALAYA_GARDEN_PROVIDER_KIND=not-a-real-kind\n", "utf8");

    // No secret_ref present -> the product default is host_worker (Alaya owns
    // no LLM). official_api is reached only via secret presence or an explicit
    // declared provider_kind.
    await expect(harness.service.getRuntimeGardenComputeConfig()).resolves.toMatchObject({
      config_version: 1,
      provider_kind: "host_worker"
    });
  });

  it("the persisted runtime row wins over a disagreeing ALAYA_GARDEN_PROVIDER_KIND env default", async () => {
    const harness = await createServiceHarness();
    await harness.service.patchRuntimeGardenComputeConfig({
      provider_kind: "host_worker",
      provider_url: null,
      secret_ref: null,
      model_id: null,
      enabled: false
    });
    // Make the env disagree with the persisted row.
    await writeFile(harness.paths.envPath, "ALAYA_GARDEN_PROVIDER_KIND=local_heuristics\n", "utf8");

    await expect(harness.service.getRuntimeGardenComputeConfig()).resolves.toMatchObject({
      config_version: 1,
      provider_kind: "host_worker"
    });
  });

  it("normalizes paste mode in daemon service, writes only file refs publicly, and keeps plaintext out of audit/env", async () => {
    const harness = await createServiceHarness();
    const plaintext = "sk-test-plaintext-secret";
    const secretPath = path.join(harness.paths.secretsDir, "openai");

    const result = await harness.service.patchRuntimeEmbeddingConfig({
      embedding_enabled: true,
      secret_ref_mode: "paste",
      secret_value: plaintext,
      model_id: "text-embedding-3-small"
    });

    expect(result).toMatchObject({
      embedding_enabled: true,
      secret_ref: `file:${secretPath}`,
      model_id: "text-embedding-3-small"
    });
    await expect(readFile(secretPath, "utf8")).resolves.toBe(`${plaintext}\n`);
    expect(((await stat(harness.paths.secretsDir)).mode & 0o777)).toBe(0o700);
    expect(((await stat(secretPath)).mode & 0o777)).toBe(0o600);

    const env = await readFile(harness.paths.envPath, "utf8");
    expect(env).toContain(`ALAYA_OPENAI_SECRET_REF=file:${secretPath}`);
    expect(env).toContain("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=true");
    expect(env).not.toContain(plaintext);
    expect(JSON.stringify(harness.publishedEvents)).not.toContain(plaintext);
    expect(harness.publishedEvents[0]?.payload_json).toMatchObject({
      change_summary: {
        fields_changed: ["secret_ref", "model_id", "embedding_enabled"],
        secret_ref_kind: "file"
      }
    });
  });

  it("routes paste mode through the real EventLog repo before config and secret persistence", async () => {
    const database = initDatabase();
    try {
      const configDir = await mkdtemp(path.join(tmpdir(), "daemon-config-live-"));
      const paths = resolveAlayaConfigPaths(configDir);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const configService = createConfigService({
        configRepo: new SqliteConfigRepo(database),
        eventPublisher: new EventPublisher({
          eventLogRepo,
          runHotStateService: { apply: vi.fn() },
          runtimeNotifier: {
            notify: vi.fn(),
            notifyEntry: vi.fn()
          }
        }),
        configPathsProvider: () => paths,
        clock: () => "2026-05-01T00:00:00.000Z",
        generateAuditId: () => "audit-live"
      });
      const app = new Hono();
      const plaintext = "sk-live-route-secret";
      const secretPath = path.join(paths.secretsDir, "openai");
      registerConfigRoutes(app, {
        workspaceService: { getById: vi.fn() },
        configService
      } as any);

      const response = await app.request("/config/runtime/embedding-supplement", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embedding_enabled: true,
          secret_ref_mode: "paste",
          secret_value: plaintext
        })
      });

      expect(response.status).toBe(200);
      const responseBody = await response.text();
      expect(responseBody).toContain(`file:${secretPath}`);
      expect(responseBody).not.toContain(plaintext);
      const events = await eventLogRepo.queryByEntity("runtime_config", "runtime:embedding-supplement");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
        caused_by: "inspector",
        payload_json: {
          entry_id: "audit-live",
          event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
          change_summary: {
            fields_changed: ["secret_ref", "embedding_enabled"],
            secret_ref_kind: "file"
          }
        }
      });
      expect(JSON.stringify(events)).not.toContain(plaintext);
      await expect(readFile(secretPath, "utf8")).resolves.toBe(`${plaintext}\n`);
    } finally {
      database.close();
    }
  });

  it("reports dedicated Garden credential provenance from the config env before embedding fallback", async () => {
    const harness = await createServiceHarness({
      env: {
        ALAYA_OPENAI_SECRET_REF: "env:ALAYA_TEST_OPENAI_KEY"
      } as NodeJS.ProcessEnv
    });
    await writeFile(
      harness.paths.envPath,
      "ALAYA_GARDEN_OPENAI_SECRET_REF=env:ALAYA_GARDEN_TEST_OPENAI_KEY\n",
      "utf8"
    );

    await expect(harness.service.getGardenCredentialProvenance()).resolves.toEqual({ kind: "env" });
  });

  it("reports deprecated embedding fallback provenance when no dedicated Garden ref exists", async () => {
    const harness = await createServiceHarness({
      env: {
        ALAYA_OPENAI_SECRET_REF: "file:/tmp/alaya-openai-secret"
      } as NodeJS.ProcessEnv
    });

    await expect(harness.service.getGardenCredentialProvenance()).resolves.toEqual({
      kind: "embedding-fallback"
    });
  });

  it("rejects paste mode on win32 before EventLog mutation", async () => {
    const harness = await createServiceHarness({ platform: "win32" });

    await expect(
      harness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      })
    ).rejects.toThrow("paste mode is not supported on win32");
    expect(harness.appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("rejects empty paste and bogus secret modes before EventLog mutation", async () => {
    const emptyHarness = await createServiceHarness();
    await expect(
      emptyHarness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: ""
      })
    ).rejects.toThrow("Invalid runtime embedding config patch");
    expect(emptyHarness.appendManyWithMutation).not.toHaveBeenCalled();

    const bogusHarness = await createServiceHarness();
    await expect(
      bogusHarness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "bogus",
        secret_value: "sk-test-plaintext-secret"
      })
    ).rejects.toThrow("Invalid runtime embedding config patch");
    expect(bogusHarness.appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("uses exclusive temp files so a pre-existing temp symlink blocks secret writes", async () => {
    const harness = await createServiceHarness({ tempIds: ["fixed"] });
    const secretPath = path.join(harness.paths.secretsDir, "openai");
    await mkdir(harness.paths.secretsDir, { recursive: true, mode: 0o700 });
    await symlink("/tmp/alaya-secret-target", `${secretPath}.fixed.tmp`);

    await expect(
      harness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      })
    ).rejects.toThrow();
    await expect(harness.service.getRuntimeEmbeddingConfig()).resolves.toEqual({
      config_version: 1,
      provider_url: null,
      secret_ref: null,
      model_id: null,
      embedding_enabled: false
    });
    expect(harness.publishedEvents).toHaveLength(0);
  });

  it("rejects a symlinked secrets directory before writing pasted plaintext", async () => {
    const harness = await createServiceHarness();
    const leakDir = await mkdtemp(path.join(tmpdir(), "daemon-secret-leak-"));
    await symlink(leakDir, harness.paths.secretsDir);

    await expect(
      harness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      })
    ).rejects.toThrow("Private config path is not a directory");

    await expect(readdir(leakDir)).resolves.toEqual([]);
    await expect(harness.service.getRuntimeEmbeddingConfig()).resolves.toEqual({
      config_version: 1,
      provider_url: null,
      secret_ref: null,
      model_id: null,
      embedding_enabled: false
    });
    expect(harness.publishedEvents).toHaveLength(0);
  });

  it("rejects a symlinked config directory before runtime env writes", async () => {
    const parentDir = await mkdtemp(path.join(tmpdir(), "daemon-config-parent-"));
    const leakDir = await mkdtemp(path.join(tmpdir(), "daemon-config-leak-"));
    const configDir = path.join(parentDir, "config-link");
    await symlink(leakDir, configDir);
    const paths = resolveAlayaConfigPaths(configDir);
    const persist = vi.fn(async () => ({
      provider_url: null,
      secret_ref: null,
      model_id: null,
      embedding_enabled: true
    }));

    await expect(
      applyRuntimeEmbeddingConfigFiles({
        paths,
        normalized: {
          patch: { embedding_enabled: true },
          pastedSecret: null
        },
        generateTempId: () => "config-link",
        persist,
        lockTimeoutMs: 20,
        lockRetryMs: 1
      })
    ).rejects.toThrow("Private config path is not a directory");

    expect(persist).not.toHaveBeenCalled();
    await expect(readdir(leakDir)).resolves.toEqual([]);
  });

  it("cleans pasted secrets and env writes when config persistence rejects the mutation", async () => {
    const failingRepo = createMemoryConfigRepo();
    const patch = vi.fn(() => {
      throw new Error("repo write failed");
    });
    const harness = await createServiceHarness({
      repo: {
        ...failingRepo,
        patch
      }
    });
    const secretPath = path.join(harness.paths.secretsDir, "openai");

    await expect(
      harness.service.patchRuntimeEmbeddingConfig({
        embedding_enabled: true,
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      })
    ).rejects.toThrow("repo write failed");

    await expect(readFile(secretPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(harness.paths.envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.publishedEvents).toHaveLength(0);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("does not let an earlier rollback clobber a later paste write for the same config files", async () => {
    // Gate the first call's atomic publish so the second call queues on the
    // FS lock; when the first call's persist throws, applyRuntimeEmbeddingConfigFiles
    // restores the FS files, then the second call proceeds and writes its own
    // pasted secret. The repo write is sync, so the gate lives at the publish
    // boundary.
    const backingRepo = createMemoryConfigRepo();
    const firstPublishStarted = createDeferred<void>();
    const firstPublishCanFail = createDeferred<void>();
    let publishCalls = 0;
    const harness = await createServiceHarness({ repo: backingRepo });
    const realAppend = (
      harness.appendManyWithMutation.getMockImplementation()! as (...args: unknown[]) => unknown
    ).bind(harness.appendManyWithMutation);
    harness.appendManyWithMutation.mockImplementation(async (events: any, mutate: any) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        firstPublishStarted.resolve();
        await firstPublishCanFail.promise;
        throw new Error("first persist failed");
      }
      return await realAppend(events, mutate);
    });
    const secretPath = path.join(harness.paths.secretsDir, "openai");

    const first = harness.service.patchRuntimeEmbeddingConfig({
      embedding_enabled: true,
      secret_ref_mode: "paste",
      secret_value: "sk-first-secret"
    });
    await firstPublishStarted.promise;
    const second = harness.service.patchRuntimeEmbeddingConfig({
      embedding_enabled: true,
      secret_ref_mode: "paste",
      secret_value: "sk-second-secret"
    });

    firstPublishCanFail.resolve();
    await expect(first).rejects.toThrow("first persist failed");
    await expect(second).resolves.toMatchObject({
      embedding_enabled: true,
      secret_ref: `file:${secretPath}`
    });

    await expect(readFile(secretPath, "utf8")).resolves.toBe("sk-second-secret\n");
    await expect(readFile(harness.paths.envPath, "utf8")).resolves.toContain(
      `ALAYA_OPENAI_SECRET_REF=file:${secretPath}`
    );
    expect(harness.publishedEvents).toHaveLength(1);
  });

  it("honors an OS-visible runtime config lock before snapshotting files", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "daemon-config-lock-"));
    const paths = resolveAlayaConfigPaths(configDir);
    const lockPath = `${paths.envPath}.runtime-embedding.lock`;
    const persist = vi.fn(async () => ({
      provider_url: null,
      secret_ref: null,
      model_id: null,
      embedding_enabled: true
    }));
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, `${process.pid}\n2026-05-01T00:00:00.000Z\n`, {
      mode: 0o600
    });

    try {
      await expect(
        applyRuntimeEmbeddingConfigFiles({
          paths,
          normalized: {
            patch: { embedding_enabled: true },
            pastedSecret: null
          },
          generateTempId: () => "locked",
          persist,
          lockTimeoutMs: 20,
          lockRetryMs: 1
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }

    expect(persist).not.toHaveBeenCalled();
    await expect(readFile(paths.envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove stale-looking runtime config locks while waiting", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "daemon-config-stale-lock-"));
    const paths = resolveAlayaConfigPaths(configDir);
    const lockPath = `${paths.envPath}.runtime-embedding.lock`;
    const lockContent = "999999999\n2026-05-01T00:00:00.000Z\n";
    const persist = vi.fn(async () => ({
      provider_url: null,
      secret_ref: null,
      model_id: null,
      embedding_enabled: true
    }));
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(lockPath, lockContent, { mode: 0o600 });

    await expect(
      applyRuntimeEmbeddingConfigFiles({
        paths,
        normalized: {
          patch: { embedding_enabled: true },
          pastedSecret: null
        },
        generateTempId: () => "stale-locked",
        persist,
        lockTimeoutMs: 20,
        lockRetryMs: 1
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(persist).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContent);
    await unlink(lockPath).catch(() => undefined);
  });

  it("round-trips soul, strategy, and environment patches through real SqliteConfigRepo without mocking the service", async () => {
    const database = initDatabase();
    try {
      const configDir = await mkdtemp(path.join(tmpdir(), "daemon-config-section-"));
      const paths = resolveAlayaConfigPaths(configDir);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const configService = createConfigService({
        configRepo: new SqliteConfigRepo(database),
        eventPublisher: new EventPublisher({
          eventLogRepo,
          runHotStateService: { apply: vi.fn() },
          runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
        }),
        configPathsProvider: () => paths,
        clock: () => "2026-05-01T00:00:00.000Z",
        generateAuditId: () => "audit-section-live"
      });
      const app = new Hono();
      registerConfigRoutes(app, {
        workspaceService: { getById: vi.fn(async () => undefined) },
        configService
      } as any);

      const soulPatch = await app.request("/workspaces/ws-section/config/soul", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memory_hard_cap: 4096, auto_checkpoint: false })
      });
      expect(soulPatch.status).toBe(200);
      const soulGet = await app.request("/workspaces/ws-section/config/soul");
      expect(soulGet.status).toBe(200);
      const soulRound = (await soulGet.json()) as {
        data: { config_version: number; memory_hard_cap: number; auto_checkpoint: boolean };
      };
      expect(soulRound.data.config_version).toBe(1);
      expect(soulRound.data.memory_hard_cap).toBe(4096);
      expect(soulRound.data.auto_checkpoint).toBe(false);

      const strategyPatch = await app.request("/workspaces/ws-section/config/strategy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ require_bash_approval: false, auto_approve_readonly: true })
      });
      expect(strategyPatch.status).toBe(200);
      const strategyGet = await app.request("/workspaces/ws-section/config/strategy");
      const strategyRound = (await strategyGet.json()) as {
        data: {
          config_version: number;
          require_bash_approval: boolean;
          auto_approve_readonly: boolean;
        };
      };
      expect(strategyRound.data.config_version).toBe(1);
      expect(strategyRound.data.require_bash_approval).toBe(false);
      expect(strategyRound.data.auto_approve_readonly).toBe(true);

      const environmentPatch = await app.request("/workspaces/ws-section/config/environment", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktree_enabled: true, env_vars: { ALAYA_DEBUG: "1" } })
      });
      expect(environmentPatch.status).toBe(200);
      const environmentGet = await app.request("/workspaces/ws-section/config/environment");
      const environmentRound = (await environmentGet.json()) as {
        data: {
          config_version: number;
          worktree_enabled: boolean;
          env_vars: Record<string, string>;
        };
      };
      expect(environmentRound.data.config_version).toBe(1);
      expect(environmentRound.data.worktree_enabled).toBe(true);
      expect(environmentRound.data.env_vars).toEqual({ ALAYA_DEBUG: "1" });

      const events = await eventLogRepo.queryByEntity(
        "runtime_config",
        "runtime:embedding-supplement"
      );
      expect(events).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("normalizes legacy versionless workspace and runtime config rows on read and patch", async () => {
    const repo = createMemoryConfigRepo();
    repo.set("workspace:ws-legacy:soul", {
      memory_consolidation_enabled: true,
      local_heuristics_enabled: true,
      garden_backlog_soft_limit: 123,
      memory_hard_cap: 2048,
      auto_checkpoint: true
    });
    repo.set("workspace:ws-legacy:strategy", {
      require_bash_approval: true,
      require_write_approval: true,
      require_network_approval: false,
      auto_approve_readonly: false
    });
    repo.set("workspace:ws-legacy:environment", {
      env_vars: { ALAYA_DEBUG: "1" },
      worktree_enabled: true
    });
    repo.set("runtime:embedding-supplement", {
      provider_url: null,
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: false
    });
    repo.set("runtime:garden-compute", {
      provider_kind: "host_worker",
      provider_url: null,
      secret_ref: null,
      model_id: null,
      enabled: false
    });
    const harness = await createServiceHarness({ repo });

    await expect(harness.service.getSoulConfig("ws-legacy")).resolves.toMatchObject({
      config_version: 1,
      garden_backlog_soft_limit: 123
    });
    await expect(harness.service.getStrategyConfig("ws-legacy")).resolves.toMatchObject({
      config_version: 1,
      require_network_approval: false
    });
    await expect(harness.service.getEnvironmentConfig("ws-legacy")).resolves.toMatchObject({
      config_version: 1,
      env_vars: { ALAYA_DEBUG: "1" }
    });
    await expect(harness.service.getRuntimeEmbeddingConfig()).resolves.toMatchObject({
      config_version: 1,
      secret_ref: "env:OPENAI_API_KEY"
    });
    await expect(harness.service.getRuntimeGardenComputeConfig()).resolves.toMatchObject({
      config_version: 1,
      provider_kind: "host_worker"
    });

    await expect(
      harness.service.patchSoulConfig("ws-legacy", {
        auto_checkpoint: false
      })
    ).resolves.toMatchObject({
      config_version: 1,
      auto_checkpoint: false
    });
    expect(repo.get<Record<string, unknown>>("workspace:ws-legacy:soul")).toMatchObject({
      config_version: 1,
      auto_checkpoint: false
    });

    await expect(
      harness.service.patchRuntimeEmbeddingConfig({
        embedding_enabled: true
      })
    ).resolves.toMatchObject({
      config_version: 1,
      embedding_enabled: true
    });
    expect(repo.get<Record<string, unknown>>("runtime:embedding-supplement")).toMatchObject({
      config_version: 1,
      embedding_enabled: true
    });
  });

  it("serializes same-path paste writes without exposing plaintext in responses", async () => {
    const harness = await createServiceHarness();
    const secretPath = path.join(harness.paths.secretsDir, "openai");

    const [first, second] = await Promise.all([
      harness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: "sk-first-secret"
      }),
      harness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: "sk-second-secret"
      })
    ]);

    expect(first.secret_ref).toBe(`file:${secretPath}`);
    expect(second.secret_ref).toBe(`file:${secretPath}`);
    expect(["sk-first-secret\n", "sk-second-secret\n"]).toContain(await readFile(secretPath, "utf8"));
    expect(JSON.stringify([first, second, harness.publishedEvents])).not.toContain("sk-first-secret");
    expect(JSON.stringify([first, second, harness.publishedEvents])).not.toContain("sk-second-secret");
    expect(harness.publishedEvents).toHaveLength(2);
  });
});

async function createServiceHarness(options: {
  readonly platform?: NodeJS.Platform;
  readonly tempIds?: readonly string[];
  readonly repo?: ConfigRepo;
  readonly env?: NodeJS.ProcessEnv;
} = {}): Promise<{
  readonly service: ReturnType<typeof createConfigService>;
  readonly paths: AlayaConfigPaths;
  readonly publishedEvents: EventLogEntry[];
  readonly appendManyWithMutation: ReturnType<typeof vi.fn>;
}> {
  const repo = options.repo ?? createMemoryConfigRepo();
  const configDir = await mkdtemp(path.join(tmpdir(), "daemon-config-"));
  const paths = resolveAlayaConfigPaths(configDir);
  const publishedEvents: EventLogEntry[] = [];
  const appendManyWithMutation = vi.fn(
    async <T>(
      events: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T> => {
      const persisted = events.map(
        (event, idx) =>
          ({
            ...event,
            event_id: `event-${publishedEvents.length + idx + 1}`,
            created_at: "2026-05-01T00:00:00.000Z",
            revision: publishedEvents.length + idx + 1
          }) as EventLogEntry
      );
      // Snapshot length before the mutate so a thrown mutate cleanly rolls
      // back the appended rows (mirrors EventPublisher.appendManyWithMutation
      // transactional semantics in tests that don't wire a real publisher).
      const before = publishedEvents.length;
      publishedEvents.push(...persisted);
      try {
        return mutate(persisted);
      } catch (error) {
        publishedEvents.length = before;
        throw error;
      }
    }
  );
  let tempIndex = 0;
  return {
    service: createConfigService({
      configRepo: repo,
      eventPublisher: {
        appendManyWithMutation
      } as Parameters<typeof createConfigService>[0]["eventPublisher"],
      configPathsProvider: () => paths,
      clock: () => "2026-05-01T00:00:00.000Z",
      platform: options.platform,
      generateAuditId: () => `audit-${publishedEvents.length + 1}`,
      generateTempId: () => options.tempIds?.[tempIndex++] ?? `tmp-${tempIndex++}`,
      envProvider: () => options.env ?? process.env
    }),
    paths,
    publishedEvents,
    appendManyWithMutation
  };
}

function createMemoryConfigRepo(): ConfigRepo {
  const values = new Map<string, unknown>();
  const get = <T,>(key: string): T | null => (values.get(key) as T | undefined) ?? null;
  const set = <T,>(key: string, value: T): void => {
    values.set(key, value);
  };
  const patch = <T extends Record<string, unknown>>(
    key: string,
    partial: Partial<T>,
    defaults: T
  ): T => {
    const current = get<T>(key) ?? defaults;
    const next = { ...current, ...partial } as T;
    set(key, next);
    return next;
  };
  return {
    get,
    set,
    patch
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
