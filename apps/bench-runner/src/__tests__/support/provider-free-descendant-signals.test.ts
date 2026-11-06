import childProcess, { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { installProviderFreeBoundary } from "./provider-free-boundary.js";

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
    const isolation = installProviderFreeBoundary({ descendantPreload: new URL("./provider-free-cli-bootstrap.mjs", import.meta.url).href });
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

it("refuses shell dispatch before any unregistered Node descendant can start", async () => {
  const isolation = installProviderFreeBoundary({ descendantPreload: new URL("./provider-free-cli-bootstrap.mjs", import.meta.url).href });
  try {
    expect(() => childProcess.execSync("node -e 'process.exit(0)'" )).toThrow("direct execution");
    await expect(promisify(childProcess.exec)("node -e 'process.exit(0)'" )).rejects.toThrow("direct execution");
    expect(() => childProcess.spawn(process.execPath, ["-e", "process.exit(0)"], { shell: true })).toThrow("direct execution");
    expect(isolation.violations).toEqual([]); // Propagation refusals are guard-owned evidence, not message scans.
    expect(() => isolation.assertSafe(true)).toThrow("unverifiable shell dispatch");
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it("fails closed when a Node descendant exits without confirming its guard", async () => {
  const isolation = installProviderFreeBoundary({ descendantPreload: new URL("./provider-free-cli-bootstrap.mjs", import.meta.url).href });
  try {
    await promisify(childProcess.execFile)(process.execPath, ["--invalid-isolation-fixture-flag"], { env: {} }).catch(() => undefined);
    expect(isolation.violations).toEqual([]);
    expect(() => isolation.assertSafe(true)).toThrow("unconfirmed_descendant");
  } finally { isolation.restore(); rmSync(isolation.evidence.root, { recursive: true, force: true }); }
});

it("retains concurrent child and Worker refusals, including a grandchild, independently of reap callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-signal-concurrent-"));
  const program = join(root, "actors.mjs"), child = join(root, "nested.mjs");
  const guard = new URL("./provider-free-boundary.ts", import.meta.url).href;
  const bootstrap = new URL("./provider-free-cli-bootstrap.mjs", import.meta.url).href;
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
  const guard = new URL("./provider-free-boundary.ts", import.meta.url).href;
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
