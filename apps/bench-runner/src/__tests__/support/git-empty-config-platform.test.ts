import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const { createReadOnlyGitExecutionPolicy } = await import(/* @vite-ignore */
  new URL("./read-only-git-boundary.mjs", import.meta.url).href);

it("measures native Git empty-config devices without importing application code", () => {
  // This is an independent conformance witness, not a new environment policy.
  // Pin the existing production spelling without evaluating its application module.
  const source = readFileSync(new URL("../../runs/extraction/authority/inspection.ts", import.meta.url), "utf8");
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
    expect(source).toContain(`${key}: process.platform === "win32" ? "NUL" : "/dev/null"`);
  }
  const productionDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const policy = createReadOnlyGitExecutionPolicy();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-empty-config-")));
  try {
    for (const directory of [".git/objects", ".git/refs", "home", "xdg"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/fixture\n");
    writeFileSync(join(root, ".git/config"), "");
    const queries = [
      { name: "effective-config", args: ["config", "--no-includes", "--null", "--list"], expected: "" },
      { name: "explicit-global-config", args: ["config", "--no-includes", "--global", "--null", "--list"], expected: "" },
      { name: "repository-metadata", args: ["rev-parse", "--is-inside-work-tree"], expected: "true\n" }
    ];
    const candidates = [{ name: "existing-production", device: productionDevice }];
    if (devNull !== productionDevice) candidates.push({ name: "node-os-dev-null", device: devNull });
    const observations = candidates.map(candidate => ({
      candidate: candidate.name, device: candidate.device,
      queries: queries.map(query => {
        // prepare revalidates the existing native executable pin. Only this test
        // varies its config device/cwd: measuring Git itself must not go through
        // the execution guard that replaces those values. No application entry
        // is imported or bypassed, and these literal read queries run no helpers.
        const pinned = policy.prepare("git");
        const env = {
          PATH: pinned.options.env.PATH, LANG: "C", LC_ALL: "C",
          ...(process.platform === "win32" ? { SystemRoot: pinned.options.env.SystemRoot } : {}),
          HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"),
          TMP: root, TEMP: root, TMPDIR: root,
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: candidate.device, GIT_CONFIG_SYSTEM: candidate.device,
          GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0"
        };
        const result = spawnSync(pinned.executable, query.args, {
          cwd: root, env, shell: false, windowsHide: true,
          encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"]
        });
        return { name: query.name, status: result.status, signal: result.signal,
          error_name: result.error?.name ?? null, stderr: result.stderr ?? "",
          stdout: result.stdout ?? "", expected_stdout: query.expected,
          conforms: !result.error && result.status === 0 && result.stderr === "" && result.stdout === query.expected };
      })
    }));
    const receipt = { platform: process.platform, arch: process.arch, node: process.version,
      host_scope: process.platform === "win32" ? "native-windows-observation" : "non-windows-observation",
      comparison: devNull === productionDevice ? "same-device-collapsed" : "distinct-devices-measured",
      system_config: "disabled-not-read", observations };
    console.info("GIT_EMPTY_CONFIG_PLATFORM_RECEIPT", JSON.stringify(receipt));
    // Only the existing production setting is required. A distinct Node device
    // may fail; its bounded native result is evidence for a later owner decision.
    for (const query of observations[0]!.queries) {
      expect(query.conforms, JSON.stringify({ platform: process.platform, candidate: candidates[0], query })).toBe(true);
    }
    expect(readFileSync(join(root, ".git/config"), "utf8")).toBe("");
    expect(readFileSync(join(root, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/fixture\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
