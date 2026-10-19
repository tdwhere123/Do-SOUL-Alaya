import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const policyURL = new URL("./read-only-git-boundary.mjs", import.meta.url);

it.each(["native", "directory alias"])("grants only the %s policy-pinned executable and refuses replacement without executing Git", kind => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-permission-")));
  const bin = join(root, "bin"), cwd = join(root, "checkout");
  mkdirSync(bin); mkdirSync(cwd);
  const executable = join(bin, process.platform === "win32" ? "git.exe" : "git");
  writeFileSync(executable, "authored inert executable fixture"); chmodSync(executable, 0o755);
  const offeredBin = kind === "directory alias" ? join(root, "alias") : bin;
  if (kind === "directory alias") symlinkSync(bin, offeredBin, "junction");
  const env = { PATH: offeredBin, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) };
  const setup = `import { createReadOnlyGitExecutionPolicy } from ${JSON.stringify(policyURL.href)};`;
  const run = (program: string, flags: string[] = [], childEnv = env) => spawnSync(process.execPath,
    [...flags, "--input-type=module", "--eval", setup + program],
    { cwd, env: childEnv, encoding: "utf8", timeout: 10_000 });
  try {
    const discovered = run("console.log(JSON.stringify(createReadOnlyGitExecutionPolicy().prepare('git').executable));");
    expect(discovered.status, discovered.stderr).toBe(0);
    const pinned: string = JSON.parse(discovered.stdout);
    expect(pinned).toBe(realpathSync(executable));
    const childEnv = { ...env, PATH: dirname(pinned) };
    const permissions = ["--permission", `--allow-fs-read=${cwd}`,
      `--allow-fs-read=${dirname(fileURLToPath(policyURL))}`];
    const probe = "createReadOnlyGitExecutionPolicy().prepare('git');";
    const denied = run(probe, permissions, childEnv);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain("cannot pin a native Git executable");
    const permissionReceipt = run(`import assert from 'node:assert/strict'; import fs from 'node:fs';
      const { authorityGitRefusalDiagnostic } = await import(${JSON.stringify(new URL("./authority-revision-git-boundary.mjs", import.meta.url).href)});
      assert.throws(() => fs.readFileSync(${JSON.stringify(executable)}), error => {
        assert.deepEqual(authorityGitRefusalDiagnostic(error), {stage:'execution_context',category:'permission'}); return true;
      });`, permissions, childEnv);
    expect(permissionReceipt.status, permissionReceipt.stderr).toBe(0);
    const allowed = run(probe, [...permissions, `--allow-fs-read=${pinned}`], childEnv);
    expect(allowed.status, allowed.stderr).toBe(0);
    const replaced = run(`import assert from 'node:assert/strict'; import fs from 'node:fs';
      const policy = createReadOnlyGitExecutionPolicy();
      assert.throws(() => policy.prepare('sh'), /pinned command/);
      assert.throws(() => policy.prepare('git', { shell: true }), /without a shell/);
      fs.unlinkSync(${JSON.stringify(executable)});
      fs.writeFileSync(${JSON.stringify(executable)}, 'replacement with different bytes');
      assert.throws(() => policy.prepare('git'), /executable changed/);`);
    expect(replaced.status, replaced.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["linux", "win32"])("keeps %s Git device admission and execution aligned without executing a synthetic binary", platform => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-device-policy-")));
  const bin = join(root, "bin"), cwd = join(root, "checkout");
  mkdirSync(bin); mkdirSync(join(cwd, ".git/objects"), { recursive: true });
  writeFileSync(join(cwd, ".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  const index = Buffer.alloc(32); index.write("DIRC"); index.writeUInt32BE(2, 4);
  writeFileSync(join(cwd, ".git/index"), index);
  const executable = join(bin, platform === "win32" ? "git.exe" : "git");
  writeFileSync(executable, "never execute this policy fixture"); chmodSync(executable, 0o755);
  const device = platform === "win32" ? "NUL" : "/dev/null";
  // This exercises the platform branches, not native Git conformance. The
  // independent Windows CI receipt supplies the native device expectation.
  const program = `import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const { createReadOnlyGitExecutionPolicy } = await import(${JSON.stringify(policyURL.href)});
    const { createAuthorityRevisionGitPolicy, authorityGitRefusalDiagnostic } = await import(${JSON.stringify(new URL("./authority-revision-git-boundary.mjs", import.meta.url).href)});
    const execution = createReadOnlyGitExecutionPolicy(), admission = createAuthorityRevisionGitPolicy(process.cwd());
    const args = ['-c','core.autocrlf=true','-c','core.fsmonitor=false','-c','core.untrackedCache=false',
      '-c','credential.helper=','-c','core.askPass=','rev-parse','HEAD','--show-toplevel'];
    const env = { GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:${JSON.stringify(device)},
      GIT_CONFIG_SYSTEM:${JSON.stringify(device)}, GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0', LC_ALL:'C' };
    const options = { cwd:process.cwd(), env, encoding:'utf8', stdio:['ignore','pipe','ignore'] };
    assert.equal(admission.prepare('git', args, options), 'identity');
    const prepared = execution.prepare('git', options);
    assert.equal(prepared.options.env.GIT_CONFIG_GLOBAL, ${JSON.stringify(device)});
    assert.equal(prepared.options.env.GIT_CONFIG_SYSTEM, ${JSON.stringify(device)});
    assert.equal(prepared.options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(prepared.options.shell, false);
    for (const changed of [{ GIT_CONFIG_GLOBAL:'forbidden-device' }, { GIT_CONFIG_SYSTEM:'forbidden-device' },
      { GIT_CONFIG_COUNT:'1' }, { FIXTURE_SECRET:'never-export-this-value' }, { NODE_OPTIONS:'forbidden-loader' }]) {
      assert.throws(() => admission.prepare('git', args, { ...options, env:{ ...env, ...changed } }), error => {
        assert.deepEqual(authorityGitRefusalDiagnostic(error), {stage:'invocation',category:'policy'}); return true;
      });
      assert.throws(() => execution.prepare('git', { env:changed }, { rejectEnvironmentInjection:true }));
    }
    assert.deepEqual(authorityGitRefusalDiagnostic(Object.assign(new Error('never-export-this-value'),
      {code:'ERR_ACCESS_DENIED'})), {stage:'execution_context',category:'permission'});
    assert.deepEqual(authorityGitRefusalDiagnostic(new Error('never-export-this-value')),
      {stage:'execution_context',category:'inspection'});
    let reads = 0;
    const accessor = Object.defineProperty({}, 'code', {get() { reads++; throw new Error('never-read-accessor'); }});
    const proxy = new Proxy({}, {get() { reads++; throw new Error('never-read-proxy'); },
      getOwnPropertyDescriptor() { throw new Error('never-export-proxy-descriptor'); }});
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const inherited = Object.create({code:'ERR_ACCESS_DENIED'});
    for (const unknown of [null, undefined, false, 1, 'sentinel', 1n, Symbol('sentinel'), accessor, proxy, revoked.proxy, inherited]) {
      assert.deepEqual(authorityGitRefusalDiagnostic(unknown), {stage:'execution_context',category:'inspection'});
    }
    assert.equal(reads, 0);
    assert.throws(() => admission.prepare('git', [...args, '--extra'], options));
    assert.throws(() => execution.prepare('git', {shell:true}));`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      cwd, env: { PATH: bin, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: "utf8", timeout: 10_000
    });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
