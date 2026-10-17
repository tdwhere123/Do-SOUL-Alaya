import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBenchDaemonLaunchConfig, BENCH_DAEMON_MANAGED_ENV_KEYS } from "../../../harness/daemon/daemon-environment.js";
import { createBenchDaemonConfigDirectoryLease } from "../../../harness/daemon/daemon-config-directory.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const defaults = { dataDir: "/fixture-data", embeddingMode: "disabled" as const,
  embeddingProviderKind: "local_onnx" as const, tokenFactory: () => "fixture" };

it("leaves ambient queue and Garden defaults intact unless launch effects are selected", () => {
  const launch = createBenchDaemonLaunchConfig({ ...defaults, ambientEnv: {
    ALAYA_SQLITE_WRITE_QUEUE: "1", ALAYA_GARDEN_PROVIDER_KIND: "host_worker",
    ALAYA_CONFLICT_DETECTION_ENABLED: "true"
  } });
  expect(dirname(launch.configDir)).toBe(tmpdir());
  expect(launch).not.toHaveProperty("embeddingStartupProbe");
  expect(launch.environment).toMatchObject({ ALAYA_SQLITE_WRITE_QUEUE: "1",
    ALAYA_GARDEN_PROVIDER_KIND: "host_worker", ALAYA_CONFLICT_DETECTION_ENABLED: "true" });
});

it("plans an owned lease under an existing explicit root without consulting ambient temp placement", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-import-launch-")); roots.push(root);
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
