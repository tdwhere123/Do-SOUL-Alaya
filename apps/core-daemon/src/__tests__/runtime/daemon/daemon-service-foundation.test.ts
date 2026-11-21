import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeNotifier } from "@do-soul/alaya-core";
import { initDatabase } from "@do-soul/alaya-storage";
import { resolveAlayaConfigPaths } from "../../../cli/support/config-files.js";
import { createDaemonRepositories } from "../../../runtime/daemon/wiring/daemon-repositories.js";
import { createDaemonServiceFoundation } from "../../../runtime/daemon/wiring/daemon-service-foundation.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("daemon service foundation effectiveEnv propagation", () => {
  it("uses caller effectiveEnv instead of raw process.env for principal runtime, zero-day policies, and orphan detection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alaya-foundation-env-"));
    tempDirs.push(root);
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    for (const tool of ["claude", "bwrap", "socat"]) {
      const toolPath = path.join(binDir, tool);
      await writeFile(toolPath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(toolPath, 0o755);
    }

    const database = initDatabase({ filename: ":memory:" });
    try {
      const runtimeNotifier: RuntimeNotifier = {
        notify: vi.fn(),
        notifyEntry: vi.fn()
      };
      const warnLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
      const effectiveEnv = {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        ALAYA_PRINCIPAL_RUNTIME: "claude_code",
        ORPHAN_DETECTION_ENABLED: "false",
        ZERO_DAY_POLICIES_JSON: JSON.stringify([
          {
            policy_id: "deny-secret-tool",
            kind: "deny_tool",
            target: "secret.tool",
            reason: "Blocked in effectiveEnv test",
            effective_at: "2020-01-01T00:00:00.000Z",
            expires_at: null
          }
        ])
      };

      const repositories = createDaemonRepositories({
        database,
        warn: vi.fn(),
        env: effectiveEnv
      });
      expect(repositories.orphanDetectionEnabled).toBe(false);
      expect(repositories.orphanRadarRepo).toBeNull();

      const foundation = await createDaemonServiceFoundation({
        ...repositories,
        database,
        filesDirectory: path.join(root, "files"),
        runtimeNotifier,
        configPaths: resolveAlayaConfigPaths(path.join(root, "config")),
        warnLogger,
        effectiveEnv,
        processEnv: {}
      });

      expect(foundation.principalCodingAvailability).toEqual({
        available: true,
        missingTools: [],
        reason: null
      });
      await expect(
        foundation.zeroDaySecurityLayer.enforceToolAccess("ws-1", "secret.tool")
      ).rejects.toThrow("deny-secret-tool");
    } finally {
      database.close();
    }
  });
});
