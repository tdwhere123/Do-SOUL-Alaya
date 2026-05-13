import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventPublisher } from "@do-soul/alaya-core";
import { initDatabase, SqliteConfigRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createConfigService } from "../services/config-service.js";
import { resolveAlayaConfigPaths } from "../cli/config-files.js";

describe("config-service legacy secret_ref fallback", () => {
  it("degrades a persisted whitespace-tainted keychain ref to local_heuristics with a warn", async () => {
    const harness = await createHarness();
    // Simulate a v0.3.2 persisted row that carried a now-invalid ref.
    harness.configRepo.set("runtime:garden-compute", {
      provider_kind: "official_api",
      provider_url: null,
      secret_ref: "keychain:alaya: openai",
      model_id: "gpt-4.1-mini",
      enabled: true
    });

    const config = await harness.configService.getRuntimeGardenComputeConfig();

    expect(config).toEqual({
      provider_kind: "local_heuristics",
      provider_url: null,
      secret_ref: null,
      model_id: "gpt-4.1-mini",
      enabled: false
    });
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("garden-compute config: rejected by schema")
    );
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("Re-run `alaya install --keychain`")
    );
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

  it("degrades an .env-derived legacy ref too, so a freshly-installed daemon also survives the upgrade", async () => {
    const harness = await createHarness({
      dotenv: "ALAYA_OFFICIAL_GARDEN_SECRET_REF=keychain:alaya:--openai\n"
    });
    // No persisted row — the env-default path runs through the same fallback.

    const config = await harness.configService.getRuntimeGardenComputeConfig();

    expect(config.secret_ref).toBe(null);
    expect(config.provider_kind).toBe("local_heuristics");
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("garden-compute env defaults: rejected by schema")
    );
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
