import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
const { authorityGitRefusalDiagnostic, createAuthorityRevisionGitPolicy } = await import(/* @vite-ignore */
  new URL("./authority-revision-git-boundary.mjs", import.meta.url).href);
const { gitEmptyConfigDevice } = await import(/* @vite-ignore */
  new URL("./read-only-git-boundary.mjs", import.meta.url).href);

const secret = "never-export-config-https://private.invalid/secret";
const admittedConfig = "[core]\nrepositoryformatversion = 0\nbare = false\n[gc]\nauto = 0\n";

// Synthetic metadata exercises the actual admission owner without executing Git,
// loading application code, accessing credentials, or inspecting the real checkout.
type Prepare = (command?: string) => unknown;
type RepositoryFixture = { root: string; prepare: Prepare };

function withRepository(check: (fixture: RepositoryFixture) => void): void {
  const previous = process.cwd();
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "authority-config-refusal-")));
  try {
    fs.mkdirSync(join(root, ".git/objects"), { recursive: true });
    fs.writeFileSync(join(root, ".git/config"), admittedConfig);
    fs.writeFileSync(join(root, ".git/config.worktree"), admittedConfig);
    const index = Buffer.alloc(32); index.write("DIRC"); index.writeUInt32BE(2, 4);
    fs.writeFileSync(join(root, ".git/index"), index);
    process.chdir(root);
    const policy = createAuthorityRevisionGitPolicy(root);
    const prepare: Prepare = (command = "git") => policy.prepare(command, [
      "-c", "core.autocrlf=true", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "credential.helper=", "-c", "core.askPass=", "rev-parse", "HEAD", "--show-toplevel"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitEmptyConfigDevice,
      GIT_CONFIG_SYSTEM: gitEmptyConfigDevice, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C"
    } });
    check({ root, prepare });
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectRefusal(prepare: () => unknown, expected: Readonly<Record<string, string>>): void {
  assert.throws(prepare, (error: unknown) => {
    const diagnostic = authorityGitRefusalDiagnostic(error);
    assert.deepEqual(diagnostic, expected);
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
    return true;
  });
}

it("admits unchanged supported common and worktree config without executing Git", () => {
  withRepository(({ prepare }) => assert.equal(prepare(), "identity"));
});

for (const [file_role, name] of [["common_config", "config"], ["worktree_config", "config.worktree"]] as const) {
  it(`admits disabled sparse-checkout residue in ${file_role}`, () => {
    withRepository(({ root, prepare }) => {
      fs.writeFileSync(join(root, ".git", name), `${admittedConfig}\n[core]\nsparseCheckout = false\nsparseCheckoutCone = false\n[index]\nsparse = false\n`);
      assert.equal(prepare(), "identity");
    });
  });

  for (const reason of ["noncanonical_file", "nonregular_file", "unsupported_syntax", "entry_not_admitted"]) {
    it(`retains only fixed ${file_role} ${reason} details on policy refusal`, () => {
      withRepository(({ root, prepare }) => {
        const path = join(root, ".git", name);
        if (reason === "noncanonical_file") {
          // A directory junction also works on Windows without file-symlink grants.
          const target = join(root, "redirected-metadata"); fs.mkdirSync(target);
          fs.unlinkSync(path); fs.symlinkSync(target, path, "junction");
        } else if (reason === "nonregular_file") {
          fs.unlinkSync(path); fs.mkdirSync(path);
        } else if (reason === "unsupported_syntax") {
          fs.writeFileSync(path, `${admittedConfig}\n${secret}\n`);
        } else {
          fs.writeFileSync(path, `${admittedConfig}\n[credential]\nhelper = ${secret}\n`);
        }
        expectRefusal(prepare, { stage: "repository_config", category: "policy", file_role, reason });
      });
    });
  }

  for (const [label, entry] of [
    ["conditional include", `[includeIf "gitdir:/fixture/.git"]\npath = ${secret}`],
    ["include", `[include]\npath = ${secret}`],
    ["hooks", `[core]\nhooksPath = ${secret}`],
    ["filter", `[filter "fixture"]\nclean = ${secret}`],
    ["textconv", `[diff "fixture"]\ntextconv = ${secret}`],
    ["unsupported known value", "[gc]\nauto = 1"],
    ["enabled sparse checkout", "[core]\nsparseCheckout = true"],
    ["enabled sparse cone", "[core]\nsparseCheckoutCone = true"],
    ["enabled sparse index", "[index]\nsparse = true"],
    ["sparse boolean alias", "[core]\nsparseCheckout = 0"],
    ["sparse core subsection", '[core "fixture"]\nsparseCheckout = false'],
    ["sparse index subsection", '[index "fixture"]\nsparse = false']
  ]) {
    it(`keeps ${label} denied in ${file_role} without returning inspected content`, () => {
      withRepository(({ root, prepare }) => {
        fs.writeFileSync(join(root, ".git", name), `${admittedConfig}\n${entry}\n`);
        expectRefusal(prepare, { stage: "repository_config", category: "policy", file_role,
          reason: "entry_not_admitted" });
      });
    });
  }
}

for (const kind of ["accessor", "proxy", "forged", "permission"]) {
  it(`keeps ${kind} inspection errors bounded without trusting error-supplied config details`, () => {
    withRepository(({ root, prepare }) => {
      let reads = 0;
      const hostile = () => { reads++; throw new Error(secret); };
      const error = kind === "proxy" ? new Proxy({}, { get: hostile, getOwnPropertyDescriptor: hostile }) :
        kind === "accessor" ? Object.defineProperties({}, {
          code: { get: hostile }, message: { get: hostile }, stack: { get: hostile },
          file_role: { get: hostile }, reason: { get: hostile }
        }) : Object.assign(new Error(secret), { code: kind === "permission" ? "ERR_ACCESS_DENIED" : "UNKNOWN",
          file_role: secret, reason: secret });
      const original = fs.readFileSync;
      try {
        // Proxy preserves the original overloads while intercepting only this fixture read.
        fs.readFileSync = new Proxy(original, {
          apply(target, thisArg: unknown, args: unknown[]): ReturnType<typeof fs.readFileSync> {
            if (args[0] === join(root, ".git/config")) throw error;
            return Reflect.apply(target, thisArg, args);
          }
        });
        syncBuiltinESMExports();
        expectRefusal(prepare, { stage: "repository_config", category: kind === "permission" ? "permission" : "inspection" });
        if (kind === "accessor") assert.equal(reads, 0);
        if (kind === "proxy") assert.equal(reads, 1); // Descriptor trap is caught; no property getter is evaluated.
      } finally {
        fs.readFileSync = original;
        syncBuiltinESMExports();
      }
      assert.equal(prepare(), "identity");
    });
  });
}

it("preserves generic invocation and nonconfig metadata refusals without config detail", () => {
  withRepository(({ root, prepare }) => {
    expectRefusal(() => prepare("sh"), { stage: "invocation", category: "policy" });
    fs.unlinkSync(join(root, ".git/index")); fs.mkdirSync(join(root, ".git/index"));
    expectRefusal(prepare, { stage: "repository_metadata", category: "policy" });
  });
});
