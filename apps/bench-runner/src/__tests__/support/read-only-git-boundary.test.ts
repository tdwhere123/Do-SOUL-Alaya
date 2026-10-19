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
