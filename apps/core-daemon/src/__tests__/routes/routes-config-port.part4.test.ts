import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { Hono } from "hono";

import { describe, expect, it, vi } from "vitest";

import {
  formatFileSecretRef
} from "@do-soul/alaya-protocol";

import { EventPublisher } from "@do-soul/alaya-core";

import {
  initDatabase,
  SqliteConfigRepo,
  SqliteEventLogRepo
} from "@do-soul/alaya-storage";

import { registerConfigRoutes } from "../../routes/workspace/config.js";
import { configRouteServices } from "../support/route-service-stubs.js";

import { createConfigService } from "../../services/config/config-service.js";

import { applyRuntimeEmbeddingConfigFiles } from "../../services/env-file/env-file-service.js";

import { resolveAlayaConfigPaths } from "../../cli/support/config-files.js";
import { createMemoryConfigRepo, createServiceHarness } from "./routes-config-port.harness.js";

const RecordConfigParser = Object.freeze({
  parse(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Config must be an object");
    }
    return value as Record<string, unknown>;
  }
});

describe("routes-config port batch", () => {

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
      registerConfigRoutes(app, configRouteServices({
        workspaceService: { getById: vi.fn(async () => undefined) },
        configService
      }));

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
    repo.setParsed("workspace:ws-legacy:soul", {
      memory_consolidation_enabled: true,
      local_heuristics_enabled: true,
      garden_backlog_soft_limit: 123,
      memory_hard_cap: 2048,
      auto_checkpoint: true
    }, RecordConfigParser);
    repo.setParsed("workspace:ws-legacy:strategy", {
      require_bash_approval: true,
      require_write_approval: true,
      require_network_approval: false,
      auto_approve_readonly: false
    }, RecordConfigParser);
    repo.setParsed("workspace:ws-legacy:environment", {
      env_vars: { ALAYA_DEBUG: "1" },
      worktree_enabled: true
    }, RecordConfigParser);
    repo.setParsed("runtime:embedding-supplement", {
      provider_url: null,
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: false
    }, RecordConfigParser);
    repo.setParsed("runtime:garden-compute", {
      provider_kind: "host_worker",
      provider_url: null,
      secret_ref: null,
      model_id: null,
      enabled: false
    }, RecordConfigParser);
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
      // A legacy saved row is version metadata, not the process/file runtime authority.
      secret_ref: null
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
    expect(repo.getParsed("workspace:ws-legacy:soul", RecordConfigParser)).toMatchObject({
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
    expect(repo.getParsed("runtime:embedding-supplement", RecordConfigParser)).toMatchObject({
      config_version: 1,
      embedding_enabled: true
    });
  });

  it("serializes same-path secret file writes without exposing plaintext in persisted config", async () => {
    const harness = await createServiceHarness();
    const secretPath = path.join(harness.paths.secretsDir, "openai");
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

    const [first, second] = await Promise.all([
      applyRuntimeEmbeddingConfigFiles({
        paths: harness.paths,
        normalized: normalized("sk-first-secret"),
        generateTempId: () => "first",
        persist
      }),
      applyRuntimeEmbeddingConfigFiles({
        paths: harness.paths,
        normalized: normalized("sk-second-secret"),
        generateTempId: () => "second",
        persist
      })
    ]);

    expect(first.secret_ref).toBe(formatFileSecretRef(secretPath));
    expect(second.secret_ref).toBe(formatFileSecretRef(secretPath));
    expect(["sk-first-secret\n", "sk-second-secret\n"]).toContain(await readFile(secretPath, "utf8"));
    expect(JSON.stringify([first, second])).not.toContain("sk-first-secret");
    expect(JSON.stringify([first, second])).not.toContain("sk-second-secret");
  });
});
