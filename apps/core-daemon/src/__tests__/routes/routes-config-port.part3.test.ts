import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { Hono } from "hono";

import { describe, expect, it, vi } from "vitest";

import {
  DYNAMICS_CONSTANTS,
  HealthEventKind,
  GardenEventType,
  formatFileSecretRef
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteConfigRepo,
  SqliteEventLogRepo
} from "@do-soul/alaya-storage";

import { registerConfigRoutes } from "../../routes/workspace/config.js";

import { applyRuntimeEmbeddingConfigFiles } from "../../services/env-file/env-file-service.js";

import { resolveAlayaConfigPaths } from "../../cli/support/config-files.js";
import { createServiceHarness } from "./routes-config-port.harness.js";

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
    const secretPath = path.join(harness.paths.secretsDir, "openai");
    await symlink(leakDir, harness.paths.secretsDir);

    await expect(
      applyRuntimeEmbeddingConfigFiles({
        paths: harness.paths,
        normalized: {
          patch: { secret_ref: formatFileSecretRef(secretPath) },
          pastedSecret: { path: secretPath, value: "sk-test-plaintext-secret" }
        },
        generateTempId: () => "symlink-test",
        persist: async () => ({
          provider_url: null,
          secret_ref: formatFileSecretRef(secretPath),
          model_id: null,
          embedding_enabled: true
        })
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
    const harness = await createServiceHarness();
    const secretPath = path.join(harness.paths.secretsDir, "openai");
    const persist = vi.fn(async () => {
      throw new Error("repo write failed");
    });

    await expect(
      applyRuntimeEmbeddingConfigFiles({
        paths: harness.paths,
        normalized: {
          patch: {
            embedding_enabled: true,
            secret_ref: formatFileSecretRef(secretPath)
          },
          pastedSecret: { path: secretPath, value: "sk-test-plaintext-secret" }
        },
        generateTempId: () => "rollback-test",
        persist
      })
    ).rejects.toThrow("repo write failed");

    await expect(readFile(secretPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(harness.paths.envPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does not let an earlier rollback clobber a later pasted secret write for the same config files", async () => {
    const harness = await createServiceHarness();
    const secretPath = path.join(harness.paths.secretsDir, "openai");
    const firstPublishStarted = createDeferred<void>();
    const firstPublishCanFail = createDeferred<void>();
    const normalized = (secretValue: string) => ({
      patch: {
        embedding_enabled: true,
        secret_ref: formatFileSecretRef(secretPath)
      },
      pastedSecret: { path: secretPath, value: secretValue }
    });
    const persist = vi.fn(async () => ({
      provider_url: null,
      secret_ref: formatFileSecretRef(secretPath),
      model_id: null,
      embedding_enabled: true
    }));

    const first = applyRuntimeEmbeddingConfigFiles({
      paths: harness.paths,
      normalized: normalized("sk-first-secret"),
      generateTempId: () => "first",
      persist: async () => {
        firstPublishStarted.resolve();
        await firstPublishCanFail.promise;
        throw new Error("first persist failed");
      }
    });
    await firstPublishStarted.promise;
    const second = applyRuntimeEmbeddingConfigFiles({
      paths: harness.paths,
      normalized: normalized("sk-second-secret"),
      generateTempId: () => "second",
      persist
    });

    firstPublishCanFail.resolve();
    await expect(first).rejects.toThrow("first persist failed");
    await expect(second).resolves.toMatchObject({
      embedding_enabled: true,
      secret_ref: formatFileSecretRef(secretPath)
    });

    await expect(readFile(secretPath, "utf8")).resolves.toBe("sk-second-secret\n");
    await expect(readFile(harness.paths.envPath, "utf8")).resolves.toContain(
      `ALAYA_OPENAI_SECRET_REF=${formatFileSecretRef(secretPath)}`
    );
    expect(harness.publishedEvents).toHaveLength(0);
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
