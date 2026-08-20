import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  listRegisteredDaemonEnvKeys,
  readDaemonProcessEnv
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
});
