import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatFileSecretRef } from "@do-soul/alaya-protocol";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const tripwire = new URL("../support/cli-bootstrap-tripwire.mjs", import.meta.url).href;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "alaya-native-config-"));
  dirs.push(dir);
  const config = path.join(dir, "config");
  const home = path.join(dir, "home");
  mkdirSync(config); mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, CI: "1", APPVEYOR: "1",
    ALAYA_CONFIG_DIR: config, ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false",
    ALAYA_EMBEDDING_PROVIDER: "openai", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1"
  };
  return { dir, config, env, file: path.join(config, ".env") };
}
function runtimeProbe(env: NodeJS.ProcessEnv, mode: string) {
  const probe = path.join(env.HOME!, "startup-probe.mjs");
  writeFileSync(probe, `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import path from "node:path";
    const loopbackFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("provider fetch forbidden"); };
    const { createAlayaDaemonRuntime, resolveSecretRef } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "apps/core-daemon/dist/index.js")).href)});
    const mode = process.argv[2];
    if (mode === "invalid") {
      await assert.rejects(createAlayaDaemonRuntime({ embeddingStartupProbe: "omit" }), /Invalid daemon env PORT/);
    } else {
      const runtime = await createAlayaDaemonRuntime({ embeddingStartupProbe: "omit" });
      try {
        if (mode === "missing") {
          await assert.rejects(runtime.startHttpServer(), /ALAYA_REQUEST_TOKEN must be set/);
        } else {
          assert.equal(runtime.startupConfig.ALAYA_REVIEWER_TOKEN, "file-review");
          assert.equal(runtime.startupConfig.ALAYA_REVIEWER_IDENTITY, "user:operator");
          assert.equal(runtime.startupConfig.DATA_DIR, undefined);
          const server = await runtime.startHttpServer();
          assert.equal(server.port, mode === "override" ? 32766 : 32765);
          const expected = mode === "override" ? "process-token" : "file-token";
          if (mode === "socket") {
            assert.equal(runtime.requestProtection.tokenSource, "rotated");
            assert.ok(existsSync(path.join(process.env.ALAYA_CONFIG_DIR, "daemon.sock")));
          } else assert.equal(runtime.requestProtection.requestToken, expected);
          const url = "http://127.0.0.1:" + server.port + "/workspaces";
          assert.equal((await loopbackFetch(url)).status, 403);
          const authenticated = await loopbackFetch(url, {
            headers: { "x-request-token": runtime.requestProtection.requestToken, "x-alaya-desktop": "1" }
          });
          assert.equal(authenticated.status, 200);
          const config = await runtime.services.configService.getRuntimeEmbeddingConfig();
          assert.equal(config.secret_ref, ${JSON.stringify(formatFileSecretRef(path.join(env.ALAYA_CONFIG_DIR!, "secrets", "openai")))});
          assert.deepEqual(resolveSecretRef(config.secret_ref), {
            ref: config.secret_ref, origin: "file", value: "synthetic-local-key"
          });
          const review = await runtime.services.mcpMemoryToolHandler.call({
            toolName: "soul.resolve",
            arguments: { target_object_id: "missing", delivery_id: "missing", resolution: "reject", reviewer_identity: "user:operator", reviewer_token: "wrong" },
            context: { workspaceId: "default", agentTarget: "inspector", runId: null, sessionId: "native-config-review" }
          });
          assert.equal(review.ok, false);
          assert.match(JSON.stringify(review), /reviewer.token|reviewer token|FORBIDDEN/i);
        }
      } finally { await runtime.shutdown(); }
    }
    console.log("native config probe passed: " + mode);
  `);
  const result = spawnSync(process.execPath, [probe, mode], { cwd: repo, env, encoding: "utf8", timeout: 25000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
  expect(result.stdout).toContain("native config probe passed: " + mode);
}

describe("built install to authenticated startup config consumption", () => {
  it("preserves operator settings through real bin install/reinstall and consumes file auth and contained secret", () => {
    const f = fixture();
    mkdirSync(path.join(f.config, "secrets"));
    writeFileSync(path.join(f.config, "secrets", "openai"), "synthetic-local-key\n");
    const operator = "PORT=32765\nALAYA_REQUEST_TOKEN=file-token\nALAYA_REVIEWER_TOKEN=file-review\nALAYA_REVIEWER_IDENTITY=user:operator\nOPERATOR_PRIVATE_KEY=retained\nDATA_DIR=must-not-select-file-db\n";
    writeFileSync(f.file, operator);
    const witness = path.join(f.dir, "transport-attempts");
    writeFileSync(witness, "");
    const answers = { embedding_provider: "openai", embedding_enabled: true,
      api_key_source: "file", key_file_path: path.join(f.config, "secrets", "openai") };
    for (const supplied of [answers, {}]) {
      const installed = spawnSync(process.execPath, ["bin/alaya.mjs", "install", "--non-interactive", JSON.stringify(supplied)], {
        cwd: repo, env: { ...f.env, NODE_OPTIONS: `--import=${tripwire}`, ALAYA_TEST_TRANSPORT_WITNESS: witness },
        encoding: "utf8", timeout: 25000
      });
      expect(installed.error).toBeUndefined();
      expect(installed.status, installed.stdout + "\n" + installed.stderr).toBe(0);
      expect(readFileSync(f.file, "utf8")).toContain(operator);
      expect(readFileSync(witness, "utf8")).toBe("");
    }
    expect(existsSync(path.join(repo, "must-not-select-file-db"))).toBe(false);
    runtimeProbe(f.env, "file");
    runtimeProbe({ ...f.env, PORT: "32766", ALAYA_REQUEST_TOKEN: "process-token" }, "override");
    // Socket-file ownership uses POSIX Unix sockets, not Windows named pipes.
    if (process.platform !== "win32") {
      writeFileSync(f.file, readFileSync(f.file, "utf8") + "ALAYA_DAEMON_SOCKET=" + path.join(f.config, "daemon.sock") + "\n");
      runtimeProbe(f.env, "socket");
    }
  }, 90000);

  it("validates file values before startup and retains ordinary HTTP no-token fail-closed", () => {
    const f = fixture();
    writeFileSync(f.file, "PORT=not-a-port\n");
    runtimeProbe(f.env, "invalid");
    expect(existsSync(path.join(f.config, "alaya.db"))).toBe(false);
    writeFileSync(f.file, "");
    runtimeProbe(f.env, "missing");
  }, 60000);
});
