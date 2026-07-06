import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { Hono } from "hono";

import { describe, expect, it, vi } from "vitest";

import {
  DYNAMICS_CONSTANTS,
  HealthEventKind,
  GardenEventType,
  formatFileSecretRef,
  type EventLogEntry
} from "@do-soul/alaya-protocol";

import { EventPublisher } from "@do-soul/alaya-core";

import {
  initDatabase,
  SqliteConfigRepo,
  SqliteEventLogRepo,
  type ConfigRepo
} from "@do-soul/alaya-storage";

import { registerConfigRoutes } from "../../routes/workspace/config.js";
import { configRouteServices } from "../support/route-service-stubs.js";

import { createConfigService } from "../../services/config-service.js";

import { applyRuntimeEmbeddingConfigFiles } from "../../services/env-file-service.js";

import { resolveAlayaConfigPaths, type AlayaConfigPaths } from "../../cli/config-files.js";

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
  const getParsed = <T,>(key: string, parser: { parse(value: unknown): T }): T | null => {
    const value = values.get(key);
    return value === undefined ? null : parser.parse(value);
  };
  const setParsed = <T,>(key: string, value: T, parser: { parse(value: unknown): T }): T => {
    const parsed = parser.parse(value);
    values.set(key, parsed);
    return parsed;
  };
  const patchParsed = <T extends Record<string, unknown>>(
    key: string,
    partial: Partial<T>,
    defaults: T,
    parser: { parse(value: unknown): T }
  ): T => {
    const current = getParsed(key, parser) ?? parser.parse(defaults);
    const next = parser.parse({ ...current, ...partial });
    setParsed(key, next, parser);
    return next;
  };
  return {
    getParsed,
    setParsed,
    patchParsed
  };
}

const RecordConfigParser = Object.freeze({
  parse(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Config must be an object");
    }
    return value as Record<string, unknown>;
  }
});

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

describe("routes-config port batch", () => {

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

  it("normalizes env secret mode in daemon service, writes only file refs publicly, and keeps plaintext out of audit/env", async () => {
    const harness = await createServiceHarness();
    const envVar = "ALAYA_TEST_OPENAI_KEY";

    const result = await harness.service.patchRuntimeEmbeddingConfig({
      embedding_enabled: true,
      secret_ref_mode: "env",
      secret_value: envVar,
      model_id: "text-embedding-3-small"
    });

    expect(result).toMatchObject({
      embedding_enabled: true,
      secret_ref: `env:${envVar}`,
      model_id: "text-embedding-3-small"
    });

    const env = await readFile(harness.paths.envPath, "utf8");
    expect(env).toContain(`ALAYA_OPENAI_SECRET_REF=env:${envVar}`);
    expect(env).toContain("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=true");
    expect(JSON.stringify(harness.publishedEvents)).not.toContain("sk-test");
    expect(harness.publishedEvents[0]?.payload_json).toMatchObject({
      change_summary: {
        fields_changed: ["secret_ref", "model_id", "embedding_enabled"],
        secret_ref_kind: "env"
      }
    });
  });

  it("routes env secret mode through the real EventLog repo before config persistence", async () => {
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
      const envVar = "ALAYA_LIVE_ROUTE_SECRET";
      registerConfigRoutes(app, configRouteServices({
        configService
      }));

      const response = await app.request("/config/runtime/embedding-supplement", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          embedding_enabled: true,
          secret_ref_mode: "env",
          secret_value: envVar
        })
      });

      expect(response.status).toBe(200);
      const responseBody = await response.text();
      expect(responseBody).toContain(`env:${envVar}`);
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
            secret_ref_kind: "env"
          }
        }
      });
      expect(JSON.stringify(events)).not.toContain("sk-live");
      await expect(readFile(paths.envPath, "utf8")).resolves.toContain(`ALAYA_OPENAI_SECRET_REF=env:${envVar}`);
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
    const tempPath = `${secretPath}.fixed.tmp`;
    const symlinkTarget = path.join(tmpdir(), "alaya-secret-target");
    await mkdir(harness.paths.secretsDir, { recursive: true, mode: 0o700 });
    await writeFile(symlinkTarget, "leaked-secret\n", { mode: 0o600 });
    await symlink(symlinkTarget, tempPath, "file");

    await expect(
      applyRuntimeEmbeddingConfigFiles({
        paths: harness.paths,
        normalized: {
          patch: {
            secret_ref: formatFileSecretRef(secretPath)
          },
          pastedSecret: {
            path: secretPath,
            value: "sk-test-plaintext-secret"
          }
        },
        generateTempId: () => "fixed",
        persist: async () => ({
          provider_url: null,
          secret_ref: formatFileSecretRef(secretPath),
          model_id: null,
          embedding_enabled: true
        })
      })
    ).rejects.toThrow();
    await expect(harness.service.getRuntimeEmbeddingConfig()).resolves.toEqual({
      config_version: 1,
      provider_url: null,
      secret_ref: null,
      model_id: null,
      embedding_enabled: true
    });
    expect(harness.publishedEvents).toHaveLength(0);
  });
});
