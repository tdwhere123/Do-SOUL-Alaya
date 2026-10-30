import { mkdir, mkdtemp, readdir, realpath, rm, symlink, unlink } from "node:fs/promises";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBenchDaemonLaunchConfig, BENCH_DAEMON_MANAGED_ENV_KEYS } from "../../../harness/daemon/daemon-environment.js";
import { createBenchDaemonConfigDirectoryLease } from "../../../harness/daemon/daemon-config-directory.js";
import { installProviderFreeBoundary } from "../../support/provider-free-boundary.js";
import { samePhysicalLocation } from "../../../runs/fs/opened-contained-path.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const defaults = { dataDir: "/fixture-data", embeddingMode: "disabled" as const,
  embeddingProviderKind: "local_onnx" as const, tokenFactory: () => "fixture" };

it("uses only an explicitly selected Source model and does not change Memory settings", () => {
  const ambientEnv = { ALAYA_SOURCE_INDEX_LOCAL_CACHE_DIR: "/stale-source", ALAYA_SOURCE_INDEX_LOCAL_MODEL: "stale/model",
    ALAYA_LOCAL_EMBEDDING_CACHE_DIR: "/memory", ALAYA_LOCAL_EMBEDDING_MODEL: "memory/model" };
  const base = createBenchDaemonLaunchConfig({ ...defaults, embeddingMode: "env", ambientEnv });
  expect(base.environment.ALAYA_SOURCE_INDEX_LOCAL_MODEL).toBeUndefined();
  expect(base.environment.ALAYA_SOURCE_INDEX_LOCAL_CACHE_DIR).toBeUndefined();
  const selected = createBenchDaemonLaunchConfig({ ...defaults, embeddingMode: "env", ambientEnv,
    cachedLocalSourceEmbedding: { cache_root: "/source", model_id: "Xenova/bge-m3" } });
  expect(selected.environment).toMatchObject({ ALAYA_SOURCE_INDEX_LOCAL_CACHE_DIR: "/source",
    ALAYA_SOURCE_INDEX_LOCAL_MODEL: "Xenova/bge-m3", ALAYA_LOCAL_EMBEDDING_CACHE_DIR: "/memory",
    ALAYA_LOCAL_EMBEDDING_MODEL: "memory/model" });
});

it("leaves ambient queue and Garden defaults intact unless launch effects are selected", () => {
  const launch = createBenchDaemonLaunchConfig({ ...defaults, ambientEnv: {
    ALAYA_SQLITE_WRITE_QUEUE: "1", ALAYA_GARDEN_PROVIDER_KIND: "host_worker",
    ALAYA_CONFLICT_DETECTION_ENABLED: "true"
  } });
  expect(dirname(launch.configDir)).toBe(realpathSync(tmpdir()));
  expect(launch).not.toHaveProperty("embeddingStartupProbe");
  expect(launch.environment).toMatchObject({ ALAYA_SQLITE_WRITE_QUEUE: "1",
    ALAYA_GARDEN_PROVIDER_KIND: "host_worker", ALAYA_CONFLICT_DETECTION_ENABLED: "true" });
});

it("plans an owned lease under an existing explicit root without consulting ambient temp placement", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "source-import-launch-"))); roots.push(root);
  const launch = createBenchDaemonLaunchConfig({ ...defaults, configDirectoryRoot: root,
    sqliteWriteQueue: "disabled", embeddingStartupProbe: "omit", gardenCompute: "disabled",
    ambientEnv: { TMPDIR: "/not-the-config-root", ALAYA_SQLITE_WRITE_QUEUE: "1",
      ALAYA_GARDEN_PROVIDER_KIND: "official_api", ALAYA_OFFICIAL_GARDEN_SECRET_REF: "env:UNREAD",
      ALAYA_CONFLICT_LLM_SECRET_REF: "env:UNREAD", ALAYA_EDGE_CLASSIFY_HOST_WORKER: "true" } });
  expect(dirname(launch.configDir)).toBe(root);
  expect(await readdir(root)).toEqual([]);
  expect(launch.embeddingStartupProbe).toBe("omit");
  expect(launch.environment).toMatchObject({ ALAYA_CONFIG_DIR: launch.configDir, ALAYA_SQLITE_WRITE_QUEUE: "0",
    ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics", ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false",
    ALAYA_EDGE_CLASSIFY_HOST_WORKER: "false", ALAYA_CONFLICT_DETECTION_ENABLED: "false",
    ALAYA_INGEST_RECONCILIATION_ENABLED: "false", ALAYA_EDGE_PRODUCER_LLM_ENABLED: "false" });
  for (const key of ["ALAYA_LOCAL_EMBEDDING_CACHE_DIR", "ALAYA_LOCAL_EMBEDDING_MODEL",
    "ALAYA_OFFICIAL_GARDEN_SECRET_REF", "ALAYA_CONFLICT_LLM_SECRET_REF"]) expect(launch.environment[key]).toBeUndefined();
  expect(BENCH_DAEMON_MANAGED_ENV_KEYS).toContain("ALAYA_SQLITE_WRITE_QUEUE");
  const lease = createBenchDaemonConfigDirectoryLease(launch.configDir);
  await lease.prepare();
  expect(await readdir(root)).toEqual([launch.configDir.slice(root.length + 1)]);
  await lease.cleanup(); await lease.cleanup();
  expect(await readdir(root)).toEqual([]);
});

it("pins the physical config directory when its parent is reached through an alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-import-aliased-root-")); roots.push(root);
  const physical = join(root, "physical"), alias = join(root, "alias");
  await mkdir(join(physical, "config"), { recursive: true });
  await symlink(physical, alias, "junction");
  const launch = createBenchDaemonLaunchConfig({ ...defaults, configDirectoryRoot: join(alias, "config"), ambientEnv: {} });
  // Unlink only the junction, never its target. Planning must have removed the
  // authored alias dependency, not merely returned another spelling of it.
  await unlink(alias);
  await expect(readdir(alias)).rejects.toMatchObject({ code: "ENOENT" });
  const aliasedLease = createBenchDaemonConfigDirectoryLease(join(alias, "config", "unresolved-alias"));
  await expect(aliasedLease.prepare()).rejects.toMatchObject({ code: "ENOENT" });
  await aliasedLease.cleanup();
  // Windows async realpath and sync realpath can retain different 8.3 spellings.
  expect(samePhysicalLocation(dirname(launch.configDir), await realpath(join(physical, "config")))).toBe(true);
  const lease = createBenchDaemonConfigDirectoryLease(launch.configDir);
  await lease.prepare();
  const name = launch.configDir.slice(dirname(launch.configDir).length + 1);
  expect(await readdir(join(physical, "config"))).toEqual([name]);
  expect(samePhysicalLocation(launch.configDir, join(physical, "config", name))).toBe(true);
  await lease.cleanup();
  expect(await readdir(join(physical, "config"))).toEqual([]);
});

it("does not create an absent explicit root or remove an unowned conflicting lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-import-lease-")); roots.push(root);
  expect(() => createBenchDaemonLaunchConfig({ ...defaults, configDirectoryRoot: join(root, "absent"), ambientEnv: {} })).toThrow();
  expect(await readdir(root)).toEqual([]);
  const first = createBenchDaemonConfigDirectoryLease(join(root, "owned"));
  await first.prepare();
  const conflicting = createBenchDaemonConfigDirectoryLease(first.path);
  await expect(conflicting.prepare()).rejects.toMatchObject({ code: "EEXIST" });
  await conflicting.cleanup();
  expect(await readdir(root)).toEqual(["owned"]);
  await first.cleanup();
});

it("rejects unsupported effect values before planning a directory", () => {
  // @ts-expect-error Invalid JavaScript caller must fail at the boundary too.
  expect(() => createBenchDaemonLaunchConfig({ ...defaults, sqliteWriteQueue: "enabled", ambientEnv: {} })).toThrow(/unsupported/);
});

it("plans the default config lease under the physical temp root", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bench-default-config-root-")));
  roots.push(root);
  const physical = join(root, "physical"), alias = join(root, "alias");
  await mkdir(physical);
  await symlink(physical, alias, "junction");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, alias);
  const launch = createBenchDaemonLaunchConfig({ ...defaults, ambientEnv: {} });
  expect(dirname(launch.configDir)).toBe(realpathSync(physical));
  await unlink(alias);
  const lease = createBenchDaemonConfigDirectoryLease(launch.configDir);
  await lease.prepare();
  expect(await readdir(physical)).toHaveLength(1);
  const isolation = installProviderFreeBoundary();
  try {
    const env = join(lease.path, ".env");
    writeFileSync(env, "FIXTURE_KEY=synthetic");
    expect(readFileSync(env, "utf8")).toBe("FIXTURE_KEY=synthetic");
    expect(isolation.violations).toEqual([]);
  } finally { isolation.restore(); await lease.cleanup(); }
  expect(await readdir(physical)).toEqual([]);
});
