import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCoreConfig,
  parseCoreConfigFromEnv,
  parseRecallRuntimeConfigFromEnv,
  resetCoreConfigForTests
} from "@do-soul/alaya-core";
import { buildBenchDiagnosticRecallPolicy } from "../../../harness/daemon/runtime/daemon-recall-result.js";
import {
  createBenchDaemonLaunchConfig
} from "../../../harness/daemon/daemon-environment.js";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import {
  buildEffectiveRecallConfigIdentity
} from "../../../longmemeval/provenance/effective-recall-config.js";

const roots: string[] = [];
let daemon: BenchDaemonHandle | undefined;

const STALE_TREATMENT_ENV = [
  "ALAYA_RECALL_CONF_SLICE_COMPATIBILITY=on",
  "ALAYA_RECALL_D2Q=true",
  "ALAYA_LOCAL_EMBEDDING_MODEL=operator/stale-embedding-model",
  "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK=true",
  "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR=/operator/stale-cross-cache",
  "ALAYA_LOCAL_CROSS_ENCODER_MODEL=operator/stale-cross-model"
].join("\n") + "\n";

const STALE_TREATMENT_KEYS = [
  "ALAYA_RECALL_CONF_SLICE_COMPATIBILITY",
  "ALAYA_RECALL_D2Q",
  "ALAYA_LOCAL_EMBEDDING_MODEL",
  "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK",
  "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR",
  "ALAYA_LOCAL_CROSS_ENCODER_MODEL"
] as const;

const POST_LAUNCH_ENV_DRIFT = Object.freeze({
  ALAYA_RECALL_CONF_SLICE_COMPATIBILITY: "on",
  ALAYA_RECALL_SEMANTIC_POST_LAUNCH_WEIGHT: "0.91",
  ALAYA_EMBEDDING_RECALL_TIERS: "cold",
  ALAYA_EMBEDDING_WORKSPACE_SCAN_CAP: "777",
  ALAYA_PATHREL_CONTENT_STRENGTH: "true",
  ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "1",
  ALAYA_LOCAL_ONNX_LOCK_PATH: "/tmp/operator-local-onnx.lock"
});

const POST_LAUNCH_ENV_DRIFT_KEYS = Object.freeze(Object.keys(POST_LAUNCH_ENV_DRIFT));

function clearEnvironment(
  keys: readonly string[]
): Partial<Record<string, string | undefined>> {
  const saved: Partial<Record<string, string | undefined>> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEnvironment(
  saved: Partial<Record<string, string | undefined>>,
  keys: readonly string[]
): void {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function expectFrozenCoreConfig(
  activeDaemon: BenchDaemonHandle,
  launch: ReturnType<typeof createBenchDaemonLaunchConfig>
): Promise<void> {
  expect(getCoreConfig()).toEqual(parseCoreConfigFromEnv(launch.environment));
  expect(process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT)
    .toBe(launch.environment.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT);
  expect(process.env.ALAYA_LOCAL_ONNX_LOCK_PATH)
    .toBe(launch.environment.ALAYA_LOCAL_ONNX_LOCK_PATH);
  const recallResult = await activeDaemon.recall("frozen core configuration probe");
  expect(recallResult.diagnostics).toMatchObject({ answer_rerank_status: "not_requested" });
  const options = { maxResults: 10, conflictAwareness: true };
  expect(buildEffectiveRecallConfigIdentity(process.env, options)).toEqual(
    buildEffectiveRecallConfigIdentity(launch.environment, options)
  );
}

afterEach(async () => {
  await daemon?.shutdown().catch(() => undefined);
  daemon = undefined;
  resetCoreConfigForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("effective bench daemon environment", () => {
  it("keeps the product recall policy free of legacy sweep overrides when unset", () => {
    const policy = buildBenchDiagnosticRecallPolicy("surface://test", 10, true);

    expect(policy.coarse_filter.semantic_supplement).toMatchObject({
      enabled: true,
      embedding_enabled: false
    });
    expect(policy.coarse_filter.semantic_supplement).not.toHaveProperty("injection_cap");
    expect(policy.coarse_filter.semantic_supplement)
      .not.toHaveProperty("injection_similarity_floor");
    expect(policy.fine_assessment.budgets.max_total_tokens).toBe(2_000);
    expect(policy.fine_assessment.max_candidates).toBe(200);
    expect(policy.coarse_filter.precomputed_rank.max_candidates).toBeGreaterThan(0);
  });

  it("freezes default model cache and source-ref settings before HOME changes", async () => {
    const operatorHome = await mkdtemp(join(tmpdir(), "bench-operator-home-"));
    const dataDir = await mkdtemp(join(tmpdir(), "bench-effective-env-"));
    roots.push(operatorHome, dataDir);

    const launch = createBenchDaemonLaunchConfig({
      dataDir,
      embeddingMode: "env",
      embeddingProviderKind: "local_onnx",
      ambientEnv: { HOME: operatorHome },
      tokenFactory: () => "test-review-token"
    });

    expect(Object.isFrozen(launch)).toBe(true);
    expect(Object.isFrozen(launch.environment)).toBe(true);
    expect(launch.environment).toMatchObject({
      HOME: join(dataDir, "home"),
      ALAYA_LOCAL_EMBEDDING_CACHE_DIR: join(
        operatorHome,
        ".cache",
        "do-soul-alaya",
        "models"
      ),
      ALAYA_RECALL_SOURCE_REF_ROBUST: "true",
      ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "true",
      ALAYA_EMBEDDING_PROVIDER: "local_onnx"
    });
  });

  it("applies and restores that resolved default environment for a real daemon lifecycle", async () => {
    const operatorHome = await mkdtemp(join(tmpdir(), "bench-lifecycle-home-"));
    const dataDir = await mkdtemp(join(tmpdir(), "bench-lifecycle-data-"));
    roots.push(operatorHome, dataDir);
    const saved = {
      HOME: process.env.HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      ALAYA_LOCAL_EMBEDDING_CACHE_DIR: process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR,
      ALAYA_RECALL_SOURCE_REF_ROBUST: process.env.ALAYA_RECALL_SOURCE_REF_ROBUST,
      ALAYA_CONFIG_DIR: process.env.ALAYA_CONFIG_DIR
    };
    process.env.HOME = operatorHome;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR;
    delete process.env.ALAYA_RECALL_SOURCE_REF_ROBUST;

    try {
      daemon = await startBenchDaemon({
        dataDirRoot: dataDir,
        embeddingMode: "env",
        embeddingProviderKind: "local_onnx"
      });
      expect(process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR).toBe(join(
        operatorHome,
        ".cache",
        "do-soul-alaya",
        "models"
      ));
      expect(process.env.ALAYA_RECALL_SOURCE_REF_ROBUST).toBe("true");
      await daemon.shutdown();
      daemon = undefined;
      expect(process.env.HOME).toBe(operatorHome);
      expect(process.env.ALAYA_LOCAL_EMBEDDING_CACHE_DIR).toBeUndefined();
      expect(process.env.ALAYA_RECALL_SOURCE_REF_ROBUST).toBeUndefined();
      expect(process.env.ALAYA_CONFIG_DIR).toBe(saved.ALAYA_CONFIG_DIR);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects a requested data root that conflicts with a prepared launch", async () => {
    const launchDataDir = await mkdtemp(join(tmpdir(), "bench-launch-data-"));
    const requestedDataDir = await mkdtemp(join(tmpdir(), "bench-requested-data-"));
    roots.push(launchDataDir, requestedDataDir);
    const launch = createBenchDaemonLaunchConfig({
      dataDir: launchDataDir,
      embeddingMode: "disabled",
      embeddingProviderKind: "local_onnx",
      tokenFactory: () => "test-review-token"
    });
    let startupError: unknown;

    try {
      daemon = await startBenchDaemon({
        dataDirRoot: requestedDataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx"
      }, launch);
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toMatchObject({
      message: "prepared bench daemon launch does not match requested options"
    });
    expect(daemon).toBeUndefined();
    await expect(access(launch.configDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays frozen core config when process env drifts after launch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bench-core-drift-"));
    roots.push(dataDir);
    const savedCoreEnv = clearEnvironment(POST_LAUNCH_ENV_DRIFT_KEYS);

    try {
      const launch = createBenchDaemonLaunchConfig({
        dataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx",
        tokenFactory: () => "test-review-token"
      });
      Object.assign(process.env, POST_LAUNCH_ENV_DRIFT);
      daemon = await startBenchDaemon({
        dataDirRoot: dataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx"
      }, launch);
      await expectFrozenCoreConfig(daemon, launch);
      await daemon.shutdown();
      daemon = undefined;
      for (const [key, value] of Object.entries(POST_LAUNCH_ENV_DRIFT)) {
        expect(process.env[key]).toBe(value);
      }
    } finally {
      try {
        await daemon?.shutdown();
        daemon = undefined;
      } finally {
        restoreEnvironment(savedCoreEnv, POST_LAUNCH_ENV_DRIFT_KEYS);
      }
    }
  });

  it("does not let a reused external data root supplement the frozen runtime config", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bench-external-data-"));
    roots.push(dataDir);
    const staleConfigDir = join(dataDir, "config");
    const staleEnvPath = join(staleConfigDir, ".env");
    await mkdir(staleConfigDir);
    await writeFile(staleEnvPath, STALE_TREATMENT_ENV, "utf8");
    const savedTreatmentEnv = clearEnvironment(STALE_TREATMENT_KEYS);

    try {
      const launch = createBenchDaemonLaunchConfig({
        dataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx",
        tokenFactory: () => "test-review-token"
      });
      const claimed = parseRecallRuntimeConfigFromEnv(launch.environment);
      expect(claimed.confSliceCompatibility).toBe(false);
      expect(launch.environment.ALAYA_RECALL_D2Q).toBeUndefined();
      expect(launch.environment.ALAYA_LOCAL_EMBEDDING_MODEL).toBeUndefined();
      expect(launch.environment.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK).toBeUndefined();

      daemon = await startBenchDaemon({
        dataDirRoot: dataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx"
      }, launch);
      expect(getCoreConfig().recall.confSliceCompatibility)
        .toBe(claimed.confSliceCompatibility);
      await expect(
        daemon.runtime.services.embeddingStatusService.getStatus(daemon.workspaceId)
      ).resolves.toMatchObject({ embedding_enabled: false, model_id: null });
      const recallResult = await daemon.recall("empty treatment isolation probe");
      expect(recallResult.diagnostics).toMatchObject({
        answer_rerank_status: "not_requested"
      });

      const isolatedConfigDir = launch.environment.ALAYA_CONFIG_DIR;
      await daemon.shutdown();
      daemon = undefined;
      expect(process.env.ALAYA_RECALL_CONF_SLICE_COMPATIBILITY).toBeUndefined();
      expect(await readFile(staleEnvPath, "utf8")).toBe(STALE_TREATMENT_ENV);
      expect(isolatedConfigDir).not.toBe(staleConfigDir);
      expect(isolatedConfigDir).toBeDefined();
      await expect(access(isolatedConfigDir ?? "")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      try {
        await daemon?.shutdown();
        daemon = undefined;
      } finally {
        restoreEnvironment(savedTreatmentEnv, STALE_TREATMENT_KEYS);
      }
    }
  });

  it.each([
    "ALAYA_RECALL_D2Q",
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  ] as const)("does not parse stale external %s", async (key) => {
    const dataDir = await mkdtemp(join(tmpdir(), "bench-stale-boolean-"));
    roots.push(dataDir);
    const configDir = join(dataDir, "config");
    await mkdir(configDir);
    await writeFile(join(configDir, ".env"), `${key}=not-a-boolean\n`, "utf8");
    const savedTreatmentEnv = clearEnvironment(STALE_TREATMENT_KEYS);

    try {
      daemon = await startBenchDaemon({
        dataDirRoot: dataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx"
      });
      await expect(
        daemon.runtime.services.embeddingStatusService.getStatus(daemon.workspaceId)
      ).resolves.toMatchObject({ embedding_enabled: false, model_id: null });
    } finally {
      try {
        await daemon?.shutdown();
        daemon = undefined;
      } finally {
        restoreEnvironment(savedTreatmentEnv, STALE_TREATMENT_KEYS);
      }
    }
  });

  it("cleans the isolated config and restores secrets after startup failure", async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), "bench-failed-start-"));
    roots.push(externalRoot);
    const invalidDataDir = join(externalRoot, "external-data-file");
    await writeFile(invalidDataDir, "operator-owned\n", "utf8");
    const saved = {
      ALAYA_CONFIG_DIR: process.env.ALAYA_CONFIG_DIR,
      ALAYA_REVIEWER_IDENTITY: process.env.ALAYA_REVIEWER_IDENTITY,
      ALAYA_REVIEWER_TOKEN: process.env.ALAYA_REVIEWER_TOKEN
    };
    const savedCoreEnv = clearEnvironment(POST_LAUNCH_ENV_DRIFT_KEYS);
    process.env.ALAYA_CONFIG_DIR = join(externalRoot, "operator-config");
    process.env.ALAYA_REVIEWER_IDENTITY = "user:operator";
    process.env.ALAYA_REVIEWER_TOKEN = "operator-token";

    try {
      const launch = createBenchDaemonLaunchConfig({
        dataDir: invalidDataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx",
        reviewerIdentity: "user:bench-failure",
        reviewerToken: "bench-secret-must-not-persist"
      });
      Object.assign(process.env, POST_LAUNCH_ENV_DRIFT);
      await expect(startBenchDaemon({
        dataDirRoot: invalidDataDir,
        embeddingMode: "disabled",
        embeddingProviderKind: "local_onnx"
      }, launch)).rejects.toThrow();

      expect(process.env.ALAYA_CONFIG_DIR).toBe(join(externalRoot, "operator-config"));
      expect(process.env.ALAYA_REVIEWER_IDENTITY).toBe("user:operator");
      expect(process.env.ALAYA_REVIEWER_TOKEN).toBe("operator-token");
      for (const [key, value] of Object.entries(POST_LAUNCH_ENV_DRIFT)) {
        expect(process.env[key]).toBe(value);
      }
      await expect(access(launch.configDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(invalidDataDir, "utf8")).toBe("operator-owned\n");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      restoreEnvironment(savedCoreEnv, POST_LAUNCH_ENV_DRIFT_KEYS);
    }
  });
});
