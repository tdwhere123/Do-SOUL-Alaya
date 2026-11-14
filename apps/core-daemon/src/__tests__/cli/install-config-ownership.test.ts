import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createInstallCommand } from "../../cli/install/install.js";
import type { AlayaCliContext } from "../../cli/bridge.js";
import { withRuntimeEmbeddingFileLock } from "../../services/env-file/env-file-io.js";
import { rollbackPartialState } from "../../cli/install/support.js";
import { formatFileSecretRef } from "@do-soul/alaya-protocol";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { resolveSecretRef } from "../../secrets/index.js";
import { parseEnv } from "../../services/env-file/env-file-format.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const fixtures: { parent: string; database: string }[] = [];
afterAll(async () => {
  for (const { parent, database } of fixtures.splice(0)) {
    // Install deliberately leaves the shared schema handle open for a live daemon.
    closeCachedDatabase(database);
    await rm(parent, { recursive: true, force: true });
  }
});
async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "alaya config owner-"));
  // Keep spaced paths while using the shared guard\'s contained config-fixture owner.
  const dir = path.join(parent, `alaya-bench-config-${randomUUID()}`);
  fixtures.push({ parent, database: path.join(dir, "alaya.db") });
  await mkdir(dir);
  let tick = 0;
  const command = createInstallCommand({
    configDirResolver: () => dir,
    clock: () => new Date(Date.UTC(2026, 10, 13, 0, 0, tick++)).toISOString()
  });
  const ctx: AlayaCliContext = {
    cwd: dir, env: {}, argv: [], stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), isTTY: false, daemon: { startupSteps: [] }
  };
  const run = (answers = {}, force = false) => command.handler(ctx, {
    nonInteractive: true, keychain: false, answers, force
  });
  return { dir, run, env: path.join(dir, ".env"), toml: path.join(dir, "alaya.toml") };
}

describe("installer config write ownership", () => {
  it("preserves operator keys/comments and removes stale installer keys on provider changes", async () => {
    const f = await fixture();
    const operator = '# operator-owned\r\nALAYA_REQUEST_TOKEN="local # token"\r\nALAYA_REVIEWER_TOKEN=review\r\nALAYA_REVIEWER_IDENTITY=user:operator\r\nUNRECOGNIZED_KEY=keep me\r\n';
    await writeFile(f.env, operator + "ALAYA_OPENAI_SECRET_REF=env:OLD\nOPENAI_EMBEDDING_PROVIDER_URL=https://old.example\n", { mode: 0o644 });
    expect((await f.run({ embedding_enabled: false })).exitCode).toBe(0);
    const first = await readFile(f.env, "utf8");
    expect(first.startsWith(operator)).toBe(true);
    expect(first).not.toContain("env:OLD");
    expect(first).not.toContain("https://old.example");
    // Windows stat has writable/read-only mode bits, not POSIX owner permissions.
    if (process.platform !== "win32") expect((await stat(f.env)).mode & 0o777).toBe(0o600);
    expect((await f.run()).exitCode).toBe(0);
    expect(await readFile(f.env, "utf8")).toBe(first);
  });

  it("rejects conflicting publication before audit or config mutation and retries after release", async () => {
    const f = await fixture();
    await writeFile(f.env, "OPERATOR=retained\n");
    await withRuntimeEmbeddingFileLock(f.env, {}, async () => {
      expect((await f.run()).exitCode).toBe(75);
      expect(await readFile(f.env, "utf8")).toBe("OPERATOR=retained\n");
      const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
      const witness = path.join(f.dir, "transport-witness");
      await writeFile(witness, "");
      const preload = new URL("../support/cli-bootstrap-tripwire.mjs", import.meta.url).href;
      const child = spawnSync(process.execPath, ["bin/alaya.mjs", "install", "--non-interactive", "{}"], {
        cwd: repo, env: {
          HOME: f.dir, PATH: process.env.PATH, APPVEYOR: "1", CI: "1",
          ALAYA_CONFIG_DIR: f.dir, ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "false",
          ALAYA_EMBEDDING_PROVIDER: "openai", NODE_OPTIONS: `--import=${preload}`,
          ALAYA_TEST_TRANSPORT_WITNESS: witness
        },
        encoding: "utf8", timeout: 20000
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stdout + child.stderr).toBe(75);
      expect(await readFile(witness, "utf8")).toBe("");
      expect(await readFile(f.env, "utf8")).toBe("OPERATOR=retained\n");
      expect(await readdir(f.dir)).not.toContain("audit");
    });
    expect((await f.run({ embedding_enabled: false })).exitCode).toBe(0);
    expect(await readdir(f.dir)).not.toContain(".env.runtime-embedding.lock");
  }, 30_000);

  it("rolls back already published TOML when env replacement fails, then permits forced retry", async () => {
    const f = await fixture();
    const original = '[storage]\ndb_path = "' + path.join(f.dir, "alaya.db") + '"\n';
    await writeFile(f.toml, original);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const realRename = actual.rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to === f.env) throw Object.assign(new Error("injected publication refusal"), { code: "EACCES" });
      return realRename(from, to);
    });
    try {
      expect((await f.run({ embedding_enabled: false })).exitCode).not.toBe(0);
      expect(await readFile(f.toml, "utf8")).toBe(original);
      const audits = await readdir(path.join(f.dir, "audit"));
      expect(JSON.parse(await readFile(path.join(f.dir, "audit", audits[0]!), "utf8")).status).toBe("failed");
    } finally { vi.mocked(rename).mockImplementation(realRename); }
    expect((await f.run({ embedding_enabled: false }, true)).exitCode).toBe(0);
  });

  it("preserves an intervening operator edit rather than blindly rolling it back", async () => {
    const f = await fixture();
    await writeFile(f.env, "OPERATOR=newer\n");
    const errors = await rollbackPartialState([{
      path: f.env, beforeContent: "OPERATOR=old\n", afterContent: "OPERATOR=installed\n"
    }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("refusing to overwrite");
    expect(await readFile(f.env, "utf8")).toBe("OPERATOR=newer\n");
  });

  it("uses runtime file-secret containment without copying an external key", async () => {
    const f = await fixture();
    const external = path.join(f.dir, "outside-key");
    await writeFile(external, "synthetic-local-key");
    expect((await f.run({ embedding_enabled: true, api_key_source: "file", key_file_path: external })).exitCode).not.toBe(0);
    expect(await readdir(f.dir)).not.toContain("secrets");
    const contained = path.join(f.dir, "secrets", "openai");
    await mkdir(path.dirname(contained));
    await writeFile(contained, "synthetic-local-key\n");
    expect((await f.run({ embedding_enabled: true, api_key_source: "file", key_file_path: contained }, true)).exitCode).toBe(0);
    const secretRef = formatFileSecretRef(contained);
    expect(parseEnv(await readFile(f.env, "utf8")).get("ALAYA_OPENAI_SECRET_REF")).toBe(secretRef);
    expect(resolveSecretRef(secretRef, {
      secretsDir: path.dirname(contained), readFile: () => "synthetic-local-key\n",
      readEnv: () => undefined, readKeychain: () => { throw new Error("not called"); }
    })).toEqual({ ref: secretRef, value: "synthetic-local-key", origin: "file" });
  });
});
