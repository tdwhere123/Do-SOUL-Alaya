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
      embedding_enabled: true
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
    const patchParsed = vi.fn(() => {
      throw new Error("repo write failed");
    });
    const harness = await createServiceHarness({
      repo: {
        ...failingRepo,
        patchParsed
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
    expect(patchParsed).toHaveBeenCalledTimes(1);
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
});
