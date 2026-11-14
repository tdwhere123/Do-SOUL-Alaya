import childProcess, { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import workers from "node:worker_threads";
import net from "node:net";
import { expect, it } from "vitest";
import { installProviderFreeBoundary } from "../../../../../scripts/test-support/provider-free/provider-free-boundary.js";
const nativeSpawnSync = childProcess.spawnSync.bind(childProcess);

it("keeps a caught parent refusal sticky even if the public violation list is cleared", () => {
  const isolation = installProviderFreeBoundary();
  try {
    expect(() => isolation.assertSafe(true)).not.toThrow();
    expect(() => readFileSync("/nonexistent-isolation-fixture/auth.json")).toThrow("credential file");
    isolation.violations.length = 0;
    expect(() => isolation.assertSafe(true)).toThrow("Provider-free isolation failed");
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it.each(["spawn", "spawnSync", "execFile", "execFileSync", "promisifiedExecFile"] as const)(
  "propagates the signal through %s with a replaced environment", async method => {
    const isolation = installProviderFreeBoundary();
    const args = ["-e", "try{require('node:fs').readFileSync('/nonexistent-isolation-fixture/auth.json')}catch{}"];
    try {
      if (method === "spawn") {
        const actor = childProcess.spawn(process.execPath, args, { env: {}, stdio: "ignore" });
        await new Promise<void>((resolve, reject) => { actor.once("exit", () => resolve()); actor.once("error", reject); });
      } else if (method === "spawnSync") childProcess.spawnSync(process.execPath, args, { env: {}, stdio: "ignore" });
      else if (method === "execFileSync") {
        try { childProcess.execFileSync(process.execPath, args, { env: {}, stdio: "ignore" }); } catch { /* Local exit is not the authority. */ }
      } else if (method === "execFile") {
        await new Promise<void>(resolve => { childProcess.execFile(process.execPath, args, { env: {} }, () => resolve()); });
      } else {
        await promisify(childProcess.execFile)(process.execPath, args, { env: {} }).catch(() => undefined);
      }
      expect(isolation.violations).toEqual([]);
      expect(() => isolation.assertSafe(true)).toThrow("violation:credential file");
    } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
  }
);

it("registers a CLI eval before application import even when inherited loader options are removed", () => {
  const preload = new URL("../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  const isolation = installProviderFreeBoundary({ descendantPreload: preload });
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PROVIDER_FIXTURE_API_KEY: "synthetic" };
    delete env.NODE_OPTIONS;
    const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", `
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const binding = JSON.parse(process.env.ALAYA_PROVIDER_FREE_ISOLATION);
      const read = name => JSON.parse(readFileSync(join(binding.root, binding.member, name), "utf8"));
      // The eval body stands for application entry: readiness must already exist.
      console.log(JSON.stringify({ binding, entry: read("entry.json"), ready: read("ready.json"),
        credentialPresent: process.env.PROVIDER_FIXTURE_API_KEY !== undefined, pid: process.pid }));
    `], { env, encoding: "utf8", timeout: 15_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.binding.root).toBe(isolation.evidence.root);
    expect(observed.binding.identity).toBe(isolation.evidence.identity);
    expect(observed.binding.member).not.toBe(isolation.evidence.member);
    expect(observed.entry).toEqual({ parent: isolation.evidence.member, kind: "spawnSync" });
    expect(observed.ready).toEqual({ pid: observed.pid, thread: 0 });
    expect(observed.pid).not.toBe(process.pid);
    expect(observed.credentialPresent).toBe(false);
    expect(() => isolation.assertSafe(true)).not.toThrow();
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it("does not rewrite a later CLI child's successful exit from a sibling's recorded violation", () => {
  const preload = new URL("../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  const isolation = installProviderFreeBoundary({ descendantPreload: preload });
  try {
    childProcess.spawnSync(process.execPath, ["-e",
      "try{require('node:fs').readFileSync('/nonexistent-isolation-fixture/auth.json')}catch{}"],
      { env: {}, encoding: "utf8", timeout: 15_000 });
    const later = childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", "console.log('ok')"],
      { env: { ...process.env }, encoding: "utf8", timeout: 15_000 });
    expect(later.status, later.stderr).toBe(0);
    expect(later.stdout.trim()).toBe("ok");
    expect(() => isolation.assertSafe(true)).toThrow("violation:credential file");
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it.each([
  ["neutral-first", "plain"], ["neutral-first", "quoted-equals"], ["neutral-first", "quoted-pair"],
  ["custom-first", "plain"], ["custom-first", "quoted-equals"], ["custom-first", "quoted-pair"]
])("preserves inherited options with %s installation and %s imports", (order, syntax) => {
  const original = { environment: process.env, fetch: globalThis.fetch, read: readFileSync,
    connect: net.Socket.prototype.connect, spawn: childProcess.spawnSync, worker: workers.Worker };
  const customPreload = new URL("../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  const neutralPreload = new URL("../../../../../scripts/test-support/provider-free/provider-free-descendant-bootstrap.mjs", import.meta.url).href;
  const customOptions = { descendantPreload: customPreload };
  const first = installProviderFreeBoundary(order === "neutral-first" ? {} : customOptions);
  const second = installProviderFreeBoundary(order === "neutral-first" ? customOptions : {});
  let secondActive = true;
  const unrelated = `--conditions="retained --import=${neutralPreload}"`;
  const offeredImport = (value: string) => syntax === "quoted-equals" ? `--import="${value}"`
    : syntax === "quoted-pair" ? `--import "${value}"` : `--import=${value}`;
  const capture = () => childProcess.spawnSync(process.execPath,
    ["-e", "console.log(JSON.stringify({fixture:process.env.E0_TEST_GARDEN_KEY!==undefined,options:process.env.NODE_OPTIONS}))"],
    { env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} ${offeredImport(neutralPreload)} ${offeredImport(customPreload)} ${unrelated}` },
      encoding: "utf8", timeout: 15_000 });
  try {
    expect(() => first.restore()).toThrow("reverse installation order");
    const strict = capture();
    expect(strict.status, strict.stderr).toBe(0);
    expect(JSON.parse(strict.stdout)).toMatchObject({ fixture: true });
    expect(JSON.parse(strict.stdout).options).toContain(unrelated);
    second.restore();
    secondActive = false;
    const plain = capture();
    expect(plain.status, plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout)).toMatchObject({ fixture: order === "custom-first" });
    expect(JSON.parse(plain.stdout).options).toContain(unrelated);
    expect(() => first.assertSafe(true)).not.toThrow();
    const inner = installProviderFreeBoundary();
    try { expect(() => readFileSync("/nonexistent-isolation-fixture/auth.json")).toThrow("credential file"); }
    finally { inner.restore(); }
    expect(() => readFileSync("/nonexistent-isolation-fixture/auth.json")).toThrow("credential file");
  } finally {
    if (secondActive) second.restore();
    first.restore();
    expect(process.env).toBe(original.environment);
    expect(globalThis.fetch).toBe(original.fetch);
    expect(readFileSync).toBe(original.read);
    expect(net.Socket.prototype.connect).toBe(original.connect);
    expect(childProcess.spawnSync).toBe(original.spawn);
    expect(workers.Worker).toBe(original.worker);
    rmSync(first.evidence.root, { recursive: true, force: true });
  }
});

it("returns, registers and terminates a real Worker subclass installed after the boundary", async () => {
  const isolation = installProviderFreeBoundary(), NativeWorker = workers.Worker;
  class FixtureWorker extends NativeWorker {}
  workers.Worker = FixtureWorker;
  let actor: workers.Worker | undefined;
  try {
    actor = new workers.Worker(`const {parentPort,threadId}=require('node:worker_threads');
      parentPort.postMessage({binding:JSON.parse(process.env.ALAYA_PROVIDER_FREE_ISOLATION),thread:threadId});
      setInterval(()=>{},1000);`, { eval: true, env: {}, execArgv: [] });
    expect(actor).toBeInstanceOf(FixtureWorker);
    const observed = await new Promise<{ binding: typeof isolation.evidence; thread: number }>((resolve, reject) => {
      actor!.once("message", resolve); actor!.once("error", reject);
    });
    expect(observed.binding.member).not.toBe(isolation.evidence.member);
    expect(JSON.parse(readFileSync(join(observed.binding.root, observed.binding.member, "ready.json"), "utf8")))
      .toEqual({ pid: process.pid, thread: observed.thread });
    await actor.terminate(); actor = undefined;
    expect(() => isolation.assertSafe(true)).not.toThrow();
  } finally {
    if (actor !== undefined) await actor.terminate();
    workers.Worker = NativeWorker; isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true });
  }
});

it("rejects an inherited parent identity without descendant registration before application entry", () => {
  const isolation = installProviderFreeBoundary();
  try {
    const guard = new URL("../../../../../scripts/test-support/provider-free/provider-free-boundary.ts", import.meta.url).href;
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const result = nativeSpawnSync(process.execPath, ["--input-type=module", "--eval", `
      const { installProviderFreeBoundary } = await import(${JSON.stringify(guard)});
      installProviderFreeBoundary();
      console.log("application entered");
    `], { env, encoding: "utf8", timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unregistered isolation descendant");
    expect(result.stdout).toBe("");
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it("refuses shell dispatch before any unregistered Node descendant can start", async () => {
  const isolation = installProviderFreeBoundary({ descendantPreload: new URL("../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
  try {
    expect(() => childProcess.execSync("node -e 'process.exit(0)'" )).toThrow("direct execution");
    await expect(promisify(childProcess.exec)("node -e 'process.exit(0)'" )).rejects.toThrow("direct execution");
    expect(() => childProcess.spawn(process.execPath, ["-e", "process.exit(0)"], { shell: true })).toThrow("direct execution");
    expect(isolation.violations).toEqual([]); // Propagation refusals are guard-owned evidence, not message scans.
    expect(() => isolation.assertSafe(true)).toThrow("unverifiable shell dispatch");
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it("fails closed when a Node descendant exits without confirming its guard", async () => {
  const isolation = installProviderFreeBoundary({ descendantPreload: new URL("../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
  try {
    await promisify(childProcess.execFile)(process.execPath, ["--invalid-isolation-fixture-flag"], { env: {} }).catch(() => undefined);
    expect(isolation.violations).toEqual([]);
    expect(() => isolation.assertSafe(true)).toThrow("unconfirmed_descendant");
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it("retains concurrent child and Worker refusals, including a grandchild, independently of reap callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-signal-concurrent-"));
  const program = join(root, "actors.mjs"), child = join(root, "nested.mjs");
  const guard = new URL("../../../../../scripts/test-support/provider-free/provider-free-boundary.ts", import.meta.url).href;
  const bootstrap = new URL("../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  const violation = `try{require('node:fs').readFileSync('/nonexistent-isolation-fixture/auth.json')}catch{}`;
  writeFileSync(child, `import {Worker} from 'node:worker_threads';
    const actor=new Worker(${JSON.stringify(violation)},{eval:true,execArgv:[],env:{}});
    await new Promise((resolve,reject)=>{actor.once('exit',resolve);actor.once('error',reject)});`);
  writeFileSync(program, `
    const {installProviderFreeBoundary}=await import(${JSON.stringify(guard)});
    const isolation=installProviderFreeBoundary({descendantPreload:${JSON.stringify(bootstrap)}});
    const {fork}=await import('node:child_process'); const {Worker}=await import('node:worker_threads');
    const actors=[fork(${JSON.stringify(child)},[],{silent:true,execArgv:[],env:{}}),
      new Worker(${JSON.stringify(violation)},{eval:true,execArgv:[],env:{}})];
    await Promise.all(actors.map(actor=>new Promise((resolve,reject)=>{actor.once('exit',resolve);actor.once('error',reject)})));
    let code;try{isolation.assertSafe(true)}catch(error){code=error.code}
    const fs=await import('node:fs'); const path=await import('node:path');
    const members=fs.readFileSync(path.join(isolation.evidence.root,'members.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);
    const violations=members.flatMap(({member})=>fs.readdirSync(path.join(isolation.evidence.root,member))).filter(name=>name.startsWith('violation-'));
    console.log(JSON.stringify({code,members:members.length,violations:violations.length}));
    isolation.restore();fs.rmSync(isolation.evidence.root,{recursive:true,force:true});
  `);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [program], { timeout: 15_000 });
    expect(JSON.parse(stdout)).toEqual({ code: "PROVIDER_FREE_ISOLATION_FAILED", members: 4, violations: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("guards the actual Source ONNX fork host despite cleared loader flags and preserves a refusal after normal child close", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-source-child-signal-"));
  const preload = join(root, "preload.mjs"), program = join(root, "source-host.mjs");
  const guard = new URL("../../../../../scripts/test-support/provider-free/provider-free-boundary.ts", import.meta.url).href;
  const host = new URL("../../../../../packages/core/dist/embedding-recall/local-onnx-process/ipc-client.js", import.meta.url).href;
  writeFileSync(preload, `
    const {installProviderFreeBoundary}=await import(${JSON.stringify(guard)});
    const isolation=installProviderFreeBoundary({descendantPreload:import.meta.url});
    let refusal;try{(await import('node:fs')).readFileSync('/nonexistent-isolation-fixture/auth.json')}catch(error){refusal=error.message}
    process.send({kind:'guard-probe',refusal,argv:process.execArgv});
    // Deliberately no exit-code failure hook: the shared guard evidence must suffice.
  `);
  writeFileSync(program, `
    const {installProviderFreeBoundary}=await import(${JSON.stringify(guard)});
    const isolation=installProviderFreeBoundary({descendantPreload:${JSON.stringify(pathToFileURL(preload).href)}});
    const {createForkLocalOnnxEmbeddingHost}=await import(${JSON.stringify(host)});
    const actor=createForkLocalOnnxEmbeddingHost().spawn();actor.ref();actor.channel.ref();
    const replies=[];const exited=new Promise((resolve,reject)=>{actor.once('exit',resolve);actor.once('error',reject)});
    await new Promise((resolve,reject)=>{
      actor.on('error',reject);actor.on('message',message=>{replies.push(message);if(message.id===1)resolve()});
      // The production child handles this local protocol refusal without creating a model.
      actor.send({id:1});
    });
    actor.send({id:2,op:'close',modelId:'unused-fixture',cacheDir:null,schemaVersion:1});
    const exit=await exited;
    let code;try{isolation.assertSafe(true)}catch(error){code=error.code}
    console.log(JSON.stringify({exit,code,replies}));
    isolation.restore();(await import('node:fs')).rmSync(isolation.evidence.root,{recursive:true,force:true});
  `);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [program], { timeout: 15_000 });
    const result = JSON.parse(stdout);
    expect(result.exit).toBe(0);
    expect(result.code).toBe("PROVIDER_FREE_ISOLATION_FAILED");
    expect(result.replies).toContainEqual({ id: 1, ok: false,
      error: { name: "Error", message: "invalid local ONNX embedding child request" } });
    expect(result.replies).toContainEqual({ id: 2, ok: true });
    expect(result.replies.find((row: { kind?: string }) => row.kind === "guard-probe")).toMatchObject({
      refusal: "Provider-free test refused credential file", argv: [`--import=${pathToFileURL(preload).href}`] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["healthy", "denial", "unconfirmed"])(
  "shares one native descendant owner across Vitest cache re-entry: %s", async mode => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const support = new URL("../../../../../scripts/test-support/provider-free/", import.meta.url);
    const fixture = fileURLToPath(new URL("native-owner-cache.fixture.ts", support));
    const bootstrap = new URL("provider-free-cli-bootstrap.mjs", support).href;
    const temporary = mkdtempSync(join(tmpdir(), "provider-owner-config-"));
    const config = join(temporary, "vitest.config.mjs"), evidence = join(temporary, "probe.json");
    writeFileSync(config, `export default ${JSON.stringify({ root, test: {
      include: [fixture], pool: "forks", maxWorkers: 1, fileParallelism: false, testTimeout: 15_000
    } })};`);
    try {
      const result = await new Promise<{ code: string | number; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath,
          ["--import", bootstrap, join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
          { cwd: root, env: { ...process.env, PROVIDER_FREE_OWNER_PROBE: mode, PROVIDER_FREE_OWNER_EVIDENCE: evidence }, timeout: 25_000 },
          (error, stdout, stderr) => resolve({ code: error === null ? 0 : error.code ?? "unknown", stdout, stderr }));
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("1 passed");
      expect(result.code, output).toBe(mode === "healthy" ? 0 : 1);
      const probe = JSON.parse(readFileSync(evidence, "utf8"));
      expect(probe.mode).toBe(mode);
      // Retain guard-owned journals, including negative-arm sticky records, for inspection.
      console.log(`OWNER_EVIDENCE:${JSON.stringify(probe)}`);
      const members: { member: string }[] = readFileSync(join(probe.root, "members.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const roots = members.filter(({ member }) => JSON.parse(readFileSync(join(probe.root, member, "entry.json"), "utf8")).parent === null);
      expect(roots).toHaveLength(1);
      const reasons: string[] = roots.flatMap(({ member }) => readdirSync(join(probe.root, member))
        .filter(name => name.startsWith("signal-failure-"))
        .flatMap(name => JSON.parse(readFileSync(join(probe.root, member, name), "utf8")).reasons));
      if (mode === "healthy") expect(reasons).toEqual([]);
      else expect(reasons.some(reason => reason.startsWith(mode === "denial" ? "violation:credential file" : "unconfirmed_descendant:"))).toBe(true);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 30_000
);
