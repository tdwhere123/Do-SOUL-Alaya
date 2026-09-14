import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  listRegisteredDaemonEnvKeys,
  listUnregisteredPrefixedDaemonEnvKeys,
  readDaemonProcessEnv,
  warnUnregisteredPrefixedDaemonEnvKeys
} from "../../../runtime/config/daemon-config-environment.js";
import { readConfigEnvValue } from "../../../runtime/daemon/lifecycle/daemon-runtime-support.js";

const SRC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_KEY = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\["([A-Z][A-Z0-9_]*)"\])/g;

async function listSourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...await listSourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("daemon env registry allowlist", () => {
  it("fails when wiring reads an unregistered process.env key", async () => {
    const registered = new Set(listRegisteredDaemonEnvKeys());
    const unknown: string[] = [];
    for (const file of await listSourceFiles(SRC_ROOT)) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(ENV_KEY)) {
        const key = match[1] ?? match[2];
        if (key !== undefined && !registered.has(key)) {
          unknown.push(`${file.slice(SRC_ROOT.length)} ${key}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("rejects an unregistered helper key", () => {
    expect(() => readDaemonProcessEnv("ALAYA_UNREGISTERED_KNOB")).toThrow(
      /unregistered daemon env key: ALAYA_UNREGISTERED_KNOB/
    );
    expect(() => readConfigEnvValue(new Map(), "ALAYA_UNREGISTERED_KNOB")).toThrow(
      /unregistered daemon env key: ALAYA_UNREGISTERED_KNOB/
    );
  });

  it("warns when ALAYA_*/OFFICIAL_* keys are set but unregistered", () => {
    const emitWarning = vi.fn();
    const unknown = warnUnregisteredPrefixedDaemonEnvKeys(
      {
        OFFICIAL_GARDEN_MODEL: "typo-key",
        ALAYA_NOT_A_REAL_KNOB: "1",
        OFFICIAL_API_GARDEN_MODEL: "ok"
      },
      emitWarning as typeof process.emitWarning
    );
    expect(unknown).toEqual(["ALAYA_NOT_A_REAL_KNOB", "OFFICIAL_GARDEN_MODEL"]);
    expect(listUnregisteredPrefixedDaemonEnvKeys({
      OFFICIAL_GARDEN_MODEL: "typo-key"
    })).toEqual(["OFFICIAL_GARDEN_MODEL"]);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("OFFICIAL_GARDEN_MODEL"),
      expect.objectContaining({ code: "ALAYA_UNREGISTERED_ENV_KEYS" })
    );
  });
});
