import { mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { Hono } from "hono";

import { describe, expect, it, vi } from "vitest";

import {
  DYNAMICS_CONSTANTS,
  HealthEventKind,
  GardenEventType
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteConfigRepo,
  SqliteEventLogRepo
} from "@do-soul/alaya-storage";

import { registerConfigRoutes } from "../../routes/workspace/config.js";
import { appConfigServiceStub } from "../support/app-config-service-stub.js";
import { configRouteServices } from "../support/route-service-stubs.js";

import { applyRuntimeEmbeddingConfigFiles } from "../../services/env-file/env-file-service.js";

import { createServiceHarness } from "./routes-config-port.harness.js";

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
    registerConfigRoutes(app, configRouteServices({
      configService
    }));

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
    registerConfigRoutes(app, configRouteServices({
      configService
    }));

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
    registerConfigRoutes(app, configRouteServices({
      workspaceService: { getById: vi.fn(async () => ({ workspace_id: "ws-budget" })) },
      configService: harness.service
    }));

    const initial = await app.request("/workspaces/ws-budget/config/manifestation-budget");
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      success: true,
      data: {
        source: "default",
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
      data: {
        source: "stored",
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

  it("reads file-only embedding settings and gives process configuration precedence without a stored row", async () => {
    const env = { OPENAI_EMBEDDING_MODEL: "process-embedding-model" };
    const harness = await createServiceHarness({ env });
    await writeFile(harness.paths.envPath, [
      "ALAYA_EMBEDDING_PROVIDER=openai",
      "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=false",
      "OPENAI_EMBEDDING_PROVIDER_URL=https://embedding.example.test/v1",
      "OPENAI_EMBEDDING_MODEL=file-embedding-model",
      "ALAYA_OPENAI_SECRET_REF=env:EMBEDDING_TEST_VALUE"
    ].join("\n"));
    await expect(harness.service.getRuntimeEmbeddingConfig()).resolves.toEqual({
      config_version: 1, embedding_enabled: false,
      provider_url: "https://embedding.example.test/v1", model_id: "process-embedding-model",
      secret_ref: "env:EMBEDDING_TEST_VALUE"
    });
    expect(harness.publishedEvents).toEqual([]);
  });

  it("reports saved Garden credential provenance instead of stale embedding-fallback environment", async () => {
    const harness = await createServiceHarness({ env: { ALAYA_OPENAI_SECRET_REF: "env:EMBEDDING_TEST_VALUE" } });
    await harness.service.patchRuntimeGardenComputeConfig({
      provider_kind: "official_api", provider_url: "https://garden.example.test/v1",
      model_id: "garden-model", secret_ref: "keychain:garden:test", enabled: false
    });
    await expect(harness.service.getGardenCredentialProvenance()).resolves.toEqual({ kind: "keychain" });
    expect(await readFile(harness.paths.envPath, "utf8")).not.toContain("ALAYA_ENABLE_GARDEN_OFFICIAL");
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
});
