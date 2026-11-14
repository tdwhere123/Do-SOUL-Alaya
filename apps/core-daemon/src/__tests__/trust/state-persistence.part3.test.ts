import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAlayaDaemonRuntime } from "../../index.js";

const tempDirs: string[] = [];

const originalDataDir = process.env.DATA_DIR;

const originalAlayaConfigDir = process.env.ALAYA_CONFIG_DIR;

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

async function createTempDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "alaya-trust-state-"));
  tempDirs.push(directory);
  return directory;
}

function setDataDir(dataDir: string): void {
  process.env.DATA_DIR = dataDir;
  // Override ALAYA_CONFIG_DIR so any user-installed alaya.toml on the
  // host machine cannot leak through resolveConfiguredDatabasePath
  // (which prefers TOML db_path over DATA_DIR).
  process.env.ALAYA_CONFIG_DIR = dataDir;
}

function restoreDataDir(): void {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }

  if (originalAlayaConfigDir === undefined) {
    delete process.env.ALAYA_CONFIG_DIR;
    return;
  }

  process.env.ALAYA_CONFIG_DIR = originalAlayaConfigDir;
}

afterEach(async () => {
  restoreDataDir();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("trust state SQL persistence", () => {

  it("rebuilds installed configured and unverifiable counters from EventLog across restart", async () => {
    const dataDir = await createTempDataDir();
    setDataDir(dataDir);

    const firstRuntime = await createAlayaDaemonRuntime();
    try {
      await firstRuntime.services.trustStateRecorder.recordInstalled("codex");
      await firstRuntime.services.trustStateRecorder.recordConfigured("codex");
      await firstRuntime.services.trustStateRecorder.recordDelivery({
        delivery_id: "delivery-counter-reset",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["memory-1"],
        delivered_at: "2026-05-01T01:00:00.000Z"
      });
      await firstRuntime.services.trustStateRecorder.recordUnverifiable("codex", "session-1");

      await expect(firstRuntime.services.trustStateRecorder.summarize("codex")).resolves.toMatchObject({
        delivered_count: 1,
        installed_count: 1,
        configured_count: 1,
        unverifiable_count: 1
      });
    } finally {
      await firstRuntime.shutdown();
    }

    const secondRuntime = await createAlayaDaemonRuntime();
    try {
      await expect(secondRuntime.services.trustStateRecorder.summarize("codex")).resolves.toMatchObject({
        delivered_count: 1,
        installed_count: 1,
        configured_count: 1,
        unverifiable_count: 1
      });
    } finally {
      await secondRuntime.shutdown();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
