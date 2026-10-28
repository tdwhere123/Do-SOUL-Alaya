import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import type { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { installProviderFreeBoundary } from "./provider-free-boundary.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "provider-boundary-fixture-")); directories.push(path); return path; };

type DescendantObservation = { entry: string; execArgv: string[]; refusal: string | null };
function descendantFixture() {
  const path = join(temporary(), "provider-isolation-child.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
let refusal = null;
try { await fetch("https://provider-fixture.invalid/v1"); }
catch (error) { refusal = error.message; }
const observation = { entry: import.meta.url, execArgv: process.execArgv, refusal };
if (parentPort) parentPort.postMessage(observation);
else process.send(observation);
`);
  return path;
}
async function observeDescendant(descendant: EventEmitter) {
  const message = new Promise<DescendantObservation>((resolve, reject) => {
    descendant.once("message", resolve); descendant.once("error", reject);
    descendant.once("exit", () => reject(new Error("descendant exited before its intended entry reported")));
  });
  const exit = new Promise<number>((resolve, reject) => {
    descendant.once("exit", resolve); descendant.once("error", reject);
  });
  const [observation, code] = await Promise.all([message, exit]);
  return { observation, code };
}

it("admits only credential fixtures in directories allocated after the unit boundary, including missing files", async () => {
  const existing = temporary();
  writeFileSync(join(existing, "auth.json"), "operator-shaped synthetic data");
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    const owned = temporary(), env = join(owned, ".env");
    writeFileSync(env, "FIXTURE_KEY=not-a-real-credential");
    expect(readFileSync(env, "utf8")).toContain("not-a-real-credential");
    await expect(readFile(join(owned, ".aws", "credentials"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const asyncOwned = await mkdtemp(join(tmpdir(), "provider-boundary-async-")); directories.push(asyncOwned);
    await writeFile(join(asyncOwned, "auth.json"), "synthetic");
    await expect(readFile(join(asyncOwned, "auth.json"), "utf8")).resolves.toBe("synthetic");
    expect(() => readFileSync(join(existing, "auth.json"), "utf8")).toThrow("credential file");
    expect(isolation.violations).toEqual(["credential file"]);
  } finally { isolation.restore(); }
});

it("refuses credential links escaping a fresh fixture and an existing machine-home-shaped path", () => {
  const outside = temporary();
  writeFileSync(join(outside, "auth.json"), "synthetic operator data");
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    const owned = temporary();
    symlinkSync(join(outside, "auth.json"), join(owned, "auth.json"));
    linkSync(join(outside, "auth.json"), join(owned, "credentials.json"));
    expect(() => readFileSync(join(owned, "auth.json"), "utf8")).toThrow("credential file");
    expect(() => readFileSync(join(owned, "credentials.json"), "utf8")).toThrow("credential file");
    expect(() => readFileSync(join(outside, ".aws", "credentials"), "utf8")).toThrow("credential file");
    expect(isolation.violations).toEqual(["credential file", "credential file", "credential file"]);
  } finally { isolation.restore(); }
});

it("still blocks non-loopback transport and strips ambient credentials before application use", async () => {
  const environment = process.env;
  process.env = { ...environment, PROVIDER_FIXTURE_API_KEY: "synthetic" };
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    expect(process.env.PROVIDER_FIXTURE_API_KEY).toBeUndefined();
    await expect(fetch("https://provider-fixture.invalid/v1")).rejects.toThrow("non-loopback fetch");
    expect(isolation.violations).toEqual(["non-loopback fetch"]);
  } finally { isolation.restore(); process.env = environment; }
});

it("leaves local fixture transport available without following redirects", async () => {
  const original = globalThis.fetch;
  const native = vi.fn<typeof fetch>(async () => new Response("local fixture"));
  globalThis.fetch = native;
  const isolation = installProviderFreeBoundary({ ownedTemporaryFixtures: true });
  try {
    await expect(fetch("http://127.0.0.1:1234/fixture", { redirect: "follow" })).resolves.toBeInstanceOf(Response);
    expect(native).toHaveBeenCalledWith("http://127.0.0.1:1234/fixture", { redirect: "error" });
    expect(isolation.violations).toEqual([]);
  } finally { isolation.restore(); globalThis.fetch = original; }
});

it.each(["supplied", "default", "already-present"] as const)("preserves repeated fork flags and provider refusal with %s execArgv", async mode => {
  const path = descendantFixture(), preload = new URL("./provider-free-cli-bootstrap.mjs", import.meta.url).href;
  const flag = `--import=${preload}`, supplied = ["--conditions", "node", "--conditions", "development",
    ...(mode === "already-present" ? [flag] : [])];
  const expected = ["--conditions", "node", "--conditions", "development", flag];
  const isolation = installProviderFreeBoundary({ descendantPreload: preload }), before = process.execArgv;
  let child: ReturnType<typeof childProcess.fork> | undefined;
  try {
    // Exercise the helper's default branch with a deterministic caller vector.
    // Restore it immediately after the synchronous child creation boundary.
    try {
      if (mode === "default") process.execArgv = supplied;
      child = childProcess.fork(path, [], { silent: true, ...(mode === "default" ? {} : { execArgv: supplied }) });
    } finally { process.execArgv = before; }
    const deadline = setTimeout(() => child?.kill("SIGKILL"), 5000);
    try {
      const { observation, code } = await observeDescendant(child);
      expect(observation.entry).toBe(pathToFileURL(path).href);
      expect(observation.execArgv).toEqual(expected);
      expect(observation.refusal).toBe("Provider-free test refused non-loopback fetch");
      expect(code).toBe(1); // The preload refuses even a caught provider attempt at exit.
      expect(supplied).toEqual(mode === "already-present" ? expected : expected.slice(0, -1));
    } finally { clearTimeout(deadline); }
  } finally { child?.kill("SIGKILL"); isolation.restore(); }
});

it("preserves repeated Worker flags and an already-present guard while retaining provider refusal", async () => {
  const path = descendantFixture(), preload = new URL("./provider-free-cli-bootstrap.mjs", import.meta.url).href;
  const supplied = ["--conditions", "node", "--conditions", "development", `--import=${preload}`];
  const expected = [...supplied], isolation = installProviderFreeBoundary({ descendantPreload: preload });
  let worker: workerThreads.Worker | undefined;
  try {
    worker = new workerThreads.Worker(pathToFileURL(path), { execArgv: supplied });
    let deadlineFired = false;
    const deadline = setTimeout(() => { deadlineFired = true; void worker?.terminate(); }, 5000);
    try {
      const { observation, code } = await observeDescendant(worker);
      expect(deadlineFired).toBe(false);
      expect(observation.entry).toBe(pathToFileURL(path).href); expect(observation.execArgv).toEqual(expected);
      expect(observation.refusal).toBe("Provider-free test refused non-loopback fetch"); expect(code).toBe(1);
      expect(supplied).toEqual(expected);
    } finally { clearTimeout(deadline); }
  } finally { await worker?.terminate(); isolation.restore(); }
});
