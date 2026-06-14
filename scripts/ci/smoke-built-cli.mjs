#!/usr/bin/env node
// Isolated built-CLI smoke: exercises the published `node bin/alaya.mjs` surface
// against a throwaway config + data dir so it never reads or migrates the host's
// real Alaya state. doctor's exit code reflects *system* health (a fresh install
// is "degraded"), so the smoke validates the emitted JSON surface instead of the
// exit code: a built CLI that boots, migrates a fresh DB to the expected schema,
// and lists the tool catalog is the contract this guards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const binPath = path.join(repoRoot, "bin", "alaya.mjs");

const workDir = mkdtempSync(path.join(tmpdir(), "alaya-cli-smoke-"));
const env = {
  ...process.env,
  ALAYA_CONFIG_DIR: path.join(workDir, "config"),
  DATA_DIR: path.join(workDir, "data")
};

function run(args) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`spawn failed for "alaya ${args.join(" ")}": ${result.error.message}`);
  }
  return result;
}

function fail(message, detail) {
  console.error(`[smoke-built-cli] FAIL: ${message}`);
  if (detail !== undefined && detail !== "") {
    console.error(detail);
  }
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

function parseJsonOrFail(label, result) {
  const text = result.stdout?.trim() ?? "";
  if (text === "") {
    fail(`${label} produced no stdout (status=${result.status})`, result.stderr);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} did not emit valid JSON (status=${result.status})`, `${error}\n${text.slice(0, 500)}`);
  }
  return undefined;
}

try {
  // 1) --help must succeed and print usage; it touches no state.
  const help = run(["--help"]);
  if (help.status !== 0 || (help.stdout?.trim() ?? "") === "") {
    fail(`--help exited ${help.status} or printed nothing`, help.stderr);
  }

  // 2) doctor --json boots the runtime and migrates a fresh DB. A degraded
  //    install exits non-zero, so assert on the JSON instead of the exit code.
  const doctor = parseJsonOrFail("doctor --json", run(["doctor", "--json"]));
  if (doctor.startup?.ready !== true) {
    fail("doctor reported startup not ready", JSON.stringify(doctor.startup));
  }
  const storage = doctor.storage ?? {};
  if (storage.schema_ok !== true) {
    fail("doctor reported storage schema not ok", JSON.stringify(storage));
  }
  if (storage.schema_version_persisted !== storage.schema_version_expected) {
    fail(
      "fresh DB did not converge to the expected schema version",
      `persisted=${storage.schema_version_persisted} expected=${storage.schema_version_expected}`
    );
  }

  // 3) tools list --json must return the live MCP tool catalog.
  const tools = parseJsonOrFail("tools list --json", run(["tools", "list", "--json"]));
  const catalog = Array.isArray(tools) ? tools : (tools.tools ?? tools.data ?? []);
  if (!Array.isArray(catalog) || catalog.length === 0) {
    fail("tools list returned an empty catalog", JSON.stringify(tools).slice(0, 500));
  }

  console.log(
    `[smoke-built-cli] OK: schema v${storage.schema_version_persisted}, ${catalog.length} tools, isolated under ${workDir}`
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
