import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localOnnxHostSingleFlightEnabled,
  resolveLocalOnnxHostLockPath,
  withLocalOnnxHostSingleFlight
} from "../../embedding-recall/local-onnx-host-single-flight.js";

describe("local-onnx-host-single-flight", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("treats only explicit truthy env values as enabled", () => {
    expect(localOnnxHostSingleFlightEnabled({})).toBe(false);
    expect(localOnnxHostSingleFlightEnabled({ ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "0" })).toBe(
      false
    );
    expect(localOnnxHostSingleFlightEnabled({ ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "1" })).toBe(
      true
    );
    expect(localOnnxHostSingleFlightEnabled({ ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT: "on" })).toBe(
      true
    );
  });

  it("resolves lock path from override or TMPDIR", () => {
    expect(
      resolveLocalOnnxHostLockPath({ ALAYA_LOCAL_ONNX_LOCK_PATH: "/tmp/custom.lock" })
    ).toBe("/tmp/custom.lock");
    const defaultPath = resolveLocalOnnxHostLockPath({ TMPDIR: "/var/tmp" });
    expect(dirname(defaultPath)).toMatch(
      new RegExp(`^${escapeRegExp(join("/var/tmp", "do-soul-alaya-"))}`)
    );
    expect(basename(defaultPath)).toBe("local-onnx-inference.lock");
  });

  it("passes through when disabled", async () => {
    const value = await withLocalOnnxHostSingleFlight(async () => 7, { enabled: false });
    expect(value).toBe(7);
  });

  it("creates the default lock inside a private per-user directory", async () => {
    const root = createRoot(roots);
    await withDefaultLockTmp(root, async () => {
      const lockPath = resolveLocalOnnxHostLockPath();
      await withLocalOnnxHostSingleFlight(async () => undefined, { enabled: true });
      const stats = statSync(dirname(lockPath));
      expect(stats.isDirectory()).toBe(true);
      expect(dirname(lockPath)).not.toBe(root);
      if (typeof process.getuid === "function") {
        expect(stats.uid).toBe(process.getuid());
      }
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o700);
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlink pre-created at the default private directory",
    async () => {
      const root = createRoot(roots);
      await withDefaultLockTmp(root, async () => {
        const lockPath = resolveLocalOnnxHostLockPath();
        const symlinkTarget = join(root, "attacker-controlled");
        mkdirSync(symlinkTarget, { mode: 0o700 });
        symlinkSync(symlinkTarget, dirname(lockPath), "dir");

        await expect(withLocalOnnxHostSingleFlight(async () => undefined, {
          enabled: true
        })).rejects.toThrow(/not a directory/);
        expect(existsSync(join(symlinkTarget, basename(lockPath)))).toBe(false);
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects an explicit lock path that is an existing symlink",
    async () => {
      const root = createRoot(roots);
      const target = join(root, "target.lock");
      const lockPath = join(root, "override.lock");
      await withLocalOnnxHostSingleFlight(async () => undefined, {
        enabled: true,
        lockPath: target
      });
      symlinkSync(target, lockPath);

      await expect(withLocalOnnxHostSingleFlight(async () => undefined, {
        enabled: true,
        lockPath
      })).rejects.toThrow(/not a regular file/);
    }
  );

  it("serializes three contenders without claim-file generations", async () => {
    const root = createRoot(roots);
    const lockPath = join(root, "inference.lock");
    let active = 0;
    let maxActive = 0;
    const run = async (label: string) =>
      withLocalOnnxHostSingleFlight(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return label;
      }, { enabled: true, lockPath, retryMs: 2, timeoutMs: 2_000 });

    await expect(Promise.all([run("R"), run("B"), run("C")])).resolves.toEqual([
      "R",
      "B",
      "C"
    ]);
    expect(maxActive).toBe(1);
    expect(existsSync(lockPath)).toBe(true);
    expect(readdirSync(root).filter((name) => name.includes(".claim-"))).toEqual([]);
  });

  it("times out behind a live transaction", async () => {
    const lockPath = join(createRoot(roots), "timeout.lock");
    let release: () => void = () => undefined;
    let acquired: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withLocalOnnxHostSingleFlight(async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    }, { enabled: true, lockPath });
    await ready;
    let now = 1_000;

    await expect(withLocalOnnxHostSingleFlight(async () => "never", {
      enabled: true,
      lockPath,
      retryMs: 5,
      timeoutMs: 30,
      now: () => now,
      sleep: async () => { now += 20; }
    })).rejects.toThrow(/timed out/);
    release();
    await holder;
  });

  it("aborts a waiter without running its operation later", async () => {
    const lockPath = join(createRoot(roots), "abort.lock");
    let release: () => void = () => undefined;
    let acquired: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withLocalOnnxHostSingleFlight(async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    }, { enabled: true, lockPath });
    await ready;
    const controller = new AbortController();
    let operationRan = false;
    const waiter = withLocalOnnxHostSingleFlight(async () => {
      operationRan = true;
    }, { enabled: true, lockPath, retryMs: 2, signal: controller.signal });

    controller.abort(new Error("caller cancelled"));
    await expect(waiter).rejects.toThrow("caller cancelled");
    release();
    await holder;
    expect(operationRan).toBe(false);
  });

  it("serializes two successors after the owner process dies", async () => {
    const lockPath = join(createRoot(roots), "owner-death.lock");
    await withLocalOnnxHostSingleFlight(async () => undefined, { enabled: true, lockPath });
    const child = spawnSqliteLockOwner(lockPath);
    try {
      const [ready] = await once(child.stdout!, "data");
      expect(String(ready)).toContain("ready");
      let active = 0;
      let maxActive = 0;
      const run = async (label: string) => withLocalOnnxHostSingleFlight(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return label;
      }, { enabled: true, lockPath, retryMs: 2, timeoutMs: 2_000 });
      const successors = Promise.all([run("B"), run("C")]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(active).toBe(0);

      const exited = once(child, "exit");
      expect(child.kill()).toBe(true);
      await exited;
      await expect(successors).resolves.toEqual(["B", "C"]);
      expect(maxActive).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit").catch(() => undefined);
      }
    }
  });

  it("fails loud without deleting a legacy text lock", async () => {
    const root = createRoot(roots);
    const lockPath = join(root, "legacy.lock");
    const legacy = `${1 << 30}\nlegacy-owner\n`;
    writeFileSync(lockPath, legacy, { flag: "wx", mode: 0o600 });
    let operationRan = false;

    await expect(withLocalOnnxHostSingleFlight(async () => {
      operationRan = true;
    }, { enabled: true, lockPath })).rejects.toThrow(/not a database/);
    expect(operationRan).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(legacy);
    expect(readdirSync(root).filter((name) => name.includes(".claim-"))).toEqual([]);
  });
});

function createRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-onnx-lock-"));
  roots.push(root);
  return root;
}

function spawnSqliteLockOwner(lockPath: string) {
  const script = [
    "import { DatabaseSync } from 'node:sqlite';",
    "const database = new DatabaseSync(process.argv[1], { timeout: 0 });",
    "database.exec('BEGIN IMMEDIATE');",
    "process.stdout.write('ready\\n');",
    "setInterval(() => undefined, 1000);"
  ].join("\n");
  return spawn(process.execPath, ["--input-type=module", "-e", script, lockPath], {
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function withDefaultLockTmp<T>(tmp: string, operation: () => Promise<T>): Promise<T> {
  const previousTmp = process.env.TMPDIR;
  const previousOverride = process.env.ALAYA_LOCAL_ONNX_LOCK_PATH;
  process.env.TMPDIR = tmp;
  delete process.env.ALAYA_LOCAL_ONNX_LOCK_PATH;
  try {
    return await operation();
  } finally {
    restoreEnv("TMPDIR", previousTmp);
    restoreEnv("ALAYA_LOCAL_ONNX_LOCK_PATH", previousOverride);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
