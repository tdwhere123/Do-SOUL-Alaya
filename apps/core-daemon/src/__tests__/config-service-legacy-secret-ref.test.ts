import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import { initDatabase, SqliteConfigRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createConfigService } from "../services/config-service.js";
import { resolveAlayaConfigPaths } from "../cli/config-files.js";

describe("config-service legacy secret_ref compatibility", () => {
  it("keeps a persisted legacy keychain ref schema-compatible for the resolver boundary", async () => {
    const harness = await createHarness();
    harness.configRepo.set("runtime:garden-compute", {
      provider_kind: "official_api",
      provider_url: null,
      secret_ref: "keychain:alaya: openai",
      model_id: "gpt-4.1-mini",
      enabled: true
    });

    const config = await harness.configService.getRuntimeGardenComputeConfig();

    expect(config.secret_ref).toBe("keychain:alaya: openai");
    expect(config.provider_kind).toBe("official_api");
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("does not warn when the persisted ref is valid", async () => {
    const harness = await createHarness();
    harness.configRepo.set("runtime:garden-compute", {
      provider_kind: "official_api",
      provider_url: null,
      secret_ref: "keychain:alaya:openai",
      model_id: "gpt-4.1-mini",
      enabled: true
    });

    const config = await harness.configService.getRuntimeGardenComputeConfig();

    expect(config.secret_ref).toBe("keychain:alaya:openai");
    expect(config.provider_kind).toBe("official_api");
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("keeps an .env-derived legacy keychain ref visible for doctor/runtime diagnostics", async () => {
    const harness = await createHarness({
      dotenv: "ALAYA_OFFICIAL_GARDEN_SECRET_REF=keychain:alaya:--openai\n"
    });

    const config = await harness.configService.getRuntimeGardenComputeConfig();

    expect(config.secret_ref).toBe("keychain:alaya:--openai");
    expect(config.provider_kind).toBe("official_api");
    expect(harness.warn).not.toHaveBeenCalled();
  });
});

async function createHarness(options: { readonly dotenv?: string } = {}) {
  const configDir = await mkdtemp(path.join(tmpdir(), "alaya-config-service-legacy-"));
  const paths = resolveAlayaConfigPaths(configDir);
  if (options.dotenv !== undefined) {
    await writeFile(paths.envPath, options.dotenv, "utf8");
  }
  const database = initDatabase({ filename: ":memory:" });
  const configRepo = new SqliteConfigRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier: { notify: () => {}, notifyEntry: () => {} }
  });
  const warn = vi.fn();
  const configService = createConfigService({
    configRepo,
    eventPublisher,
    configPathsProvider: () => paths,
    envProvider: () => ({}),
    warn
  });
  return { configRepo, configService, warn };
}
