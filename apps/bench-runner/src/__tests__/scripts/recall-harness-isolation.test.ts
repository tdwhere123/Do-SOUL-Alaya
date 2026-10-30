import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("rejects missing workload arguments with a typed validation failure and exit one", async () => {
  const harness = fileURLToPath(new URL("../../../scripts/recall-harness.mjs", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [harness], { timeout: 15_000 })
    .then(() => { throw new Error("missing workload arguments must fail the harness"); },
      (error: Error & { code: number; stdout: string; stderr: string }) => error);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--out and --arms are required");
  expect(result.stderr).toMatch(/code:\s*['"]VALIDATION['"]/u);
});

it("guards the harness main thread, explicit-argv recall workers and child processes before native imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "recall-harness-isolation # -"));
  const harness = fileURLToPath(new URL("../../../scripts/recall-harness.mjs", import.meta.url));
  const childProgram = join(root, "guard-probe.cjs");
  const source = "try { require('node:fs').readFileSync('/nonexistent-authored-harness/auth.json'); } catch (error) { console.log(error.message); }";
  writeFileSync(childProgram, source);
  // Intercept the first native application import, before dataset/config access.
  // Only synthetic nonexistent credential-shaped paths are probed, never real credentials or network.
  const probe = `
    import { readFileSync } from 'node:fs';
    import { Worker } from 'node:worker_threads';
    import { execFile, fork } from 'node:child_process';
    import { promisify } from 'node:util';
    const source = ${JSON.stringify(source)};
    let main;
    try { readFileSync('/nonexistent-authored-harness/auth.json'); } catch (error) { main=error.message; }
    const worker = await new Promise((resolve, reject) => {
      const worker = new Worker(source, { eval: true, stdout: true,
        execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
      let output=''; worker.stdout.on('data', chunk => { output+=chunk; });
      worker.on('error', reject); worker.on('exit', code => resolve({code, output}));
    });
    let child;
    try { await promisify(execFile)(process.execPath, ['-e', source], {env:process.env}); }
    catch (error) { child={code:error.code, output:error.stdout}; }
    const forked = await new Promise((resolve, reject) => {
      const env={...process.env}; delete env.NODE_OPTIONS;
      const child=fork(${JSON.stringify(childProgram)}, [], {execArgv:[], env, silent:true});
      let output=''; child.stdout.on('data', chunk => { output+=chunk; });
      child.on('error', reject); child.on('exit', code => resolve({code, output}));
    });
    console.log(JSON.stringify({main,worker,child,forked}));
    process.exit(0);
  `;
  const hook = join(root, "before-native.mjs");
  writeFileSync(hook, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('/dist/runs/snapshot/source-records/publish.js')) {
        if (!specifier.startsWith('file:')) throw new Error('native entry must use a portable file URL');
        return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(probe)}`)}, shortCircuit:true};
      }
      return nextResolve(specifier, context);
    }});`);
  try {
    const result = await promisify(execFile)(process.execPath, [`--import=${pathToFileURL(hook).href}`, harness], { timeout: 15_000 })
      .then(() => { throw new Error("caught guard violations must still fail the harness"); },
        (error: Error & { code: number; stdout: string }) => error);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.main).toContain("Provider-free test refused credential file");
    expect(report.worker).toEqual({code:1, output:"Provider-free test refused credential file\n"});
    expect(report.child).toEqual({code:1, output:"Provider-free test refused credential file\n"});
    expect(report.forked).toEqual({code:1, output:"Provider-free test refused credential file\n"});
  } finally { rmSync(root, {recursive:true, force:true}); }
});
