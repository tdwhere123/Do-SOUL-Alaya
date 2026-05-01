import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  HealthEventKind,
  Phase4AEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteConfigRepo,
  SqliteEventLogRepo,
  type ConfigRepo
} from "@do-soul/alaya-storage";
import { registerConfigRoutes } from "../routes/config.js";
import { createConfigService } from "../services/config-service.js";
import { resolveAlayaConfigPaths, type AlayaConfigPaths } from "../cli/config-files.js";

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
      patchRuntimeEmbeddingConfig: vi.fn(async (patch: unknown) => patch)
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

  it("persists runtime embedding config through the config service envelope and EventLog audit", async () => {
    const harness = await createServiceHarness();

    await harness.service.patchRuntimeEmbeddingConfig({
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    });

    await expect(harness.service.getRuntimeEmbeddingConfig()).resolves.toEqual({
      provider_url: "https://embedding.example.test/v1",
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    });
    expect(harness.publishedEvents).toHaveLength(1);
    expect(harness.publishedEvents[0]).toMatchObject({
      event_type: Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED,
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
        event_type: Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED,
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

  it("rejects paste mode on win32 before EventLog mutation", async () => {
    const harness = await createServiceHarness({ platform: "win32" });

    await expect(
      harness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: "sk-test-plaintext-secret"
      })
    ).rejects.toThrow("paste mode is not supported on win32");
    expect(harness.publishWithMutation).not.toHaveBeenCalled();
  });

  it("rejects empty paste and bogus secret modes before EventLog mutation", async () => {
    const emptyHarness = await createServiceHarness();
    await expect(
      emptyHarness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "paste",
        secret_value: ""
      })
    ).rejects.toThrow("Invalid runtime embedding config patch");
    expect(emptyHarness.publishWithMutation).not.toHaveBeenCalled();

    const bogusHarness = await createServiceHarness();
    await expect(
      bogusHarness.service.patchRuntimeEmbeddingConfig({
        secret_ref_mode: "bogus",
        secret_value: "sk-test-plaintext-secret"
      })
    ).rejects.toThrow("Invalid runtime embedding config patch");
    expect(bogusHarness.publishWithMutation).not.toHaveBeenCalled();
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
      provider_url: null,
      secret_ref: null,
      model_id: null,
      embedding_enabled: false
    });
    expect(harness.publishedEvents).toHaveLength(0);
  });

  it("cleans pasted secrets and env writes when config persistence rejects the mutation", async () => {
    const failingRepo = createMemoryConfigRepo();
    const patch = vi.fn(async () => {
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
        data: { memory_hard_cap: number; auto_checkpoint: boolean };
      };
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
        data: { require_bash_approval: boolean; auto_approve_readonly: boolean };
      };
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
        data: { worktree_enabled: boolean; env_vars: Record<string, string> };
      };
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
} = {}): Promise<{
  readonly service: ReturnType<typeof createConfigService>;
  readonly paths: AlayaConfigPaths;
  readonly publishedEvents: EventLogEntry[];
  readonly publishWithMutation: ReturnType<typeof vi.fn>;
}> {
  const repo = options.repo ?? createMemoryConfigRepo();
  const configDir = await mkdtemp(path.join(tmpdir(), "daemon-config-"));
  const paths = resolveAlayaConfigPaths(configDir);
  const publishedEvents: EventLogEntry[] = [];
  const publishWithMutation = vi.fn(
    async <T>(
      event: Omit<EventLogEntry, "event_id" | "created_at">,
      mutate: (entry: EventLogEntry) => Promise<T>
    ): Promise<T> => {
      const entry = {
        ...event,
        event_id: `event-${publishedEvents.length + 1}`,
        created_at: "2026-05-01T00:00:00.000Z"
      } as EventLogEntry;
      publishedEvents.push(entry);
      try {
        return await mutate(entry);
      } catch (error) {
        publishedEvents.pop();
        throw error;
      }
    }
  );
  let tempIndex = 0;
  return {
    service: createConfigService({
      configRepo: repo,
      eventPublisher: { publishWithMutation },
      configPathsProvider: () => paths,
      clock: () => "2026-05-01T00:00:00.000Z",
      platform: options.platform,
      generateAuditId: () => `audit-${publishedEvents.length + 1}`,
      generateTempId: () => options.tempIds?.[tempIndex++] ?? `tmp-${tempIndex++}`
    }),
    paths,
    publishedEvents,
    publishWithMutation
  };
}

function createMemoryConfigRepo(): ConfigRepo {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
    set: async <T>(key: string, value: T): Promise<void> => {
      values.set(key, value);
    },
    patch: async <T extends Record<string, unknown>>(
      key: string,
      partial: Partial<T>,
      defaults: T
    ): Promise<T> => {
      const current = (values.get(key) as T | undefined) ?? defaults;
      const next = { ...current, ...partial } as T;
      values.set(key, next);
      return next;
    }
  };
}
