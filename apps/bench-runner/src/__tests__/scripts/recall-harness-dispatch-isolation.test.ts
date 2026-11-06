import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const harness = fileURLToPath(new URL("../../../scripts/recall-harness-d1.mjs", import.meta.url));
const ids = ["isolation-first", "isolation-second"];
const modes = ["parent", "fork", "worker", "worker-terminate", "worker-unsettled", "unexpected-signal",
  "signal-unreadable", "signal-write-failed", "local", "local-child"] as const;

it.each(modes)("D1 preserves raw rows and fixed census while classifying %s independently from isolation", async mode => {
  const root = mkdtempSync(join(tmpdir(), "recall-dispatch-isolation-")), out = join(root, "out");
  const child = join(root, "child.cjs"), hook = join(root, "hook.mjs"), arms = join(root, "arms.json");
  writeFileSync(arms, JSON.stringify([{ name: "first", host: true }, { name: "second", host: true }]));
  const attempted = `try { require('node:fs').readFileSync('/nonexistent-isolation-fixture/auth.json'); } catch {}`;
  const corruptSignal = `const fs=require('node:fs'),path=require('node:path');
    const binding=JSON.parse(process.env.ALAYA_PROVIDER_FREE_ISOLATION);
    fs.renameSync(path.join(binding.root,binding.member),path.join(binding.root,binding.member+'.retired'));`;
  const childBody = `${mode === "signal-write-failed" ? corruptSignal : ""}
    ${["local-child", "worker-unsettled", "unexpected-signal"].includes(mode) ? "" : attempted}
    ${mode === "unexpected-signal" ? `process.kill(process.pid,'SIGKILL');`
      : mode === "worker-terminate" || mode === "worker-unsettled"
        ? `require('node:worker_threads').parentPort.postMessage('ready');setInterval(()=>{},1000);`
        : `process.exit(${mode === "local-child" ? 1 : 0});`}`;
  writeFileSync(child, childBody);
  const application = `
    import fs from 'node:fs'; import {join} from 'node:path';
    import {fork} from 'node:child_process'; import {Worker} from 'node:worker_threads';
    const binding=JSON.parse(process.env.ALAYA_PROVIDER_FREE_ISOLATION);
    if(!fs.existsSync(join(binding.root,binding.member,'ready.json'))) throw Error('application imported before guard readiness');
    export async function executeOrdinaryRecallEntry() {
      const mode=${JSON.stringify(mode)};
      if(mode==='parent') { ${attempted.replaceAll("require('node:fs')", "fs")} }
      if(['fork','local-child','signal-write-failed','unexpected-signal'].includes(mode)) {
        const actor=fork(${JSON.stringify(child)},[],{execArgv:[],env:{},silent:true});
        await new Promise((resolve,reject)=>{actor.on('exit',resolve);actor.on('error',reject)});
      }
      if(mode.startsWith('worker')) {
        const actor=new Worker(${JSON.stringify(childBody)},{eval:true,execArgv:[],env:{}});
        if(mode==='worker-terminate'||mode==='worker-unsettled') {
          await new Promise((resolve,reject)=>{actor.on('message',resolve);actor.on('error',reject)});
          if(mode==='worker-terminate') await actor.terminate();
          // The unsettled Worker is stopped by Node when the harness exits;
          // dispatch must not advance while ordinary cleanup is unconfirmed.
        } else await new Promise((resolve,reject)=>{actor.on('exit',resolve);actor.on('error',reject)});
      }
      if(mode==='signal-unreadable') fs.writeFileSync(join(binding.root,'members.jsonl'),'invalid signal');
      // Ordinary execution can catch and classify errors. That result must not
      // erase a guard failure, or itself become a cohort-wide isolation failure.
      try { throw Error('classified local refusal'); } catch {}
      return {input_identity:'fixture',rows:[{status:'unavailable',stop_cause:'fixture_local_refusal',
        source_intervals:[],pages:[],page_count:0,snapshot_identity:null}]};
    }
  `;
  const sources: Record<string, string> = {
    "/dist/runs/snapshot/source-records/publish.js": "export async function publishSourceSemanticSnapshot(){return {admitted_count:0,census_count:0,db_sha256:'fixture'}}",
    "/dist/runs/recall-measurement/source-index-binding.js": "export async function prepareSemanticChainSourceIndex(config){return {config}}",
    "/dist/runs/recall-measurement/ordinary/ordinary-entry-execution.js": application,
    "/recall-statement-keys.mjs": "export function statementMapDigest(){};export async function publishStatementKeys(){return {status:'published'}}",
    "/dist/datasets/longmemeval/ingestion/fetch.js": `export function longMemEvalDatasetInputPaths(_variant,options){return {sourcePath:options.dataDir+'/longmemeval_s.json'}};
      export async function loadSelectedQuestionMetadata(_variant,options){return {sha256:'fixture',entries:options.questionIds.map((id,index)=>({index,
        question:{question_id:id,question_type:'single-session-user',question:'fixture question',question_date:'2024/01/01 (Mon) 00:00'}}))}}`
  };
  writeFileSync(hook, `import {registerHooks} from 'node:module';const sources=${JSON.stringify(sources)};
    registerHooks({resolve(specifier,context,next){const key=Object.keys(sources).find(key=>specifier.endsWith(key));
      return key?{url:'data:text/javascript,'+encodeURIComponent(sources[key]),shortCircuit:true}:next(specifier,context)}});`);
  try {
    const result = await promisify(execFile)(process.execPath,
      [`--import=${pathToFileURL(hook).href}`, harness, "--out", out, "--arms", arms, "--ids", ids.join(","), "--cache", join(root, "cache")],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).then(value => ({ code: 0, ...value }),
        (error: Error & { code: number; stdout: string; stderr: string }) => error);
    const local = mode === "local" || mode === "local-child";
    expect(result.code, result.stderr).toBe(local ? 0 : 1);
    expect(existsSync(out), result.stderr).toBe(true);
    const rows = readFileSync(join(out, "rows.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => [row.question_id, row.arm, row.status])).toEqual(local
      ? ids.flatMap(id => ["first", "second"].map(arm => [id, arm, "unavailable"]))
      : [[ids[0], "first", "unavailable"]]);
    expect(JSON.parse(readFileSync(join(out, "invocation.json"), "utf8")).payload.question_ids).toEqual(ids);
    expect(readdirSync(out).filter(name => name.startsWith("isolation-failure-"))).toHaveLength(local ? 0 : 1);
    if (!local) expect(result.stderr).toContain("PROVIDER_FREE_ISOLATION_FAILED");
    if (mode === "worker-unsettled") expect(result.stderr).toContain("descendant_cleanup_incomplete");
    if (mode === "unexpected-signal") expect(result.stderr).toContain("descendant_signal_unknown");
  } finally {
    // Fixture signal files are removed only after their owning process has exited.
    try {
      for (const name of (existsSync(out) ? readdirSync(out) : []).filter(name => /^isolation-[a-f0-9-]+\.json$/u.test(name))) {
        const binding = JSON.parse(readFileSync(join(out, name), "utf8")).payload;
        rmSync(binding.root, { recursive: true, force: true });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
