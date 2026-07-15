import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFrozenCodeIdentity } from "../../longmemeval/provenance/frozen-code-contract.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("frozen code contract", () => {
  it("measures the contract, HEAD, and clean worktree instead of trusting env", async () => {
    const fixture = await cleanRepository();
    const raw = await readFile(fixture.contractPath);
    const gateSha = sha256(raw);

    const identity = await resolveFrozenCodeIdentity({
      checkoutRoot: fixture.root,
      expectedCommitSha7: fixture.head.slice(0, 7),
      env: {
        ALAYA_BENCH_GATE_CONTRACT_PATH: fixture.contractPath,
        ALAYA_BENCH_GATE_SHA256: gateSha,
        ALAYA_BENCH_WORKTREE_STATE_SHA256: fixture.worktreeSha
      }
    });

    expect(identity).toEqual({
      commitSha: fixture.head,
      commitSha7: fixture.head.slice(0, 7),
      gateContractPath: fixture.contractPath,
      gateSha256: gateSha,
      worktreeStateSha256: fixture.worktreeSha,
      worktreeClean: true
    });
  });

  it("treats digest env values only as expectations", async () => {
    const fixture = await cleanRepository();

    await expect(resolveFrozenCodeIdentity({
      checkoutRoot: fixture.root,
      expectedCommitSha7: fixture.head.slice(0, 7),
      env: {
        ALAYA_BENCH_GATE_CONTRACT_PATH: fixture.contractPath,
        ALAYA_BENCH_GATE_SHA256: "f".repeat(64)
      }
    })).rejects.toThrow(/environment.*contract/iu);
  });

  it("rejects contract commit drift and dirty worktrees", async () => {
    const fixture = await cleanRepository();
    await writeContract(fixture.contractPath, "f".repeat(40), fixture.worktreeSha);

    await expect(resolveFrozenCodeIdentity({
      checkoutRoot: fixture.root,
      expectedCommitSha7: fixture.head.slice(0, 7),
      env: { ALAYA_BENCH_GATE_CONTRACT_PATH: fixture.contractPath }
    })).rejects.toThrow(/contract.*HEAD/iu);

    await writeContract(fixture.contractPath, fixture.head, fixture.worktreeSha);
    await writeFile(join(fixture.root, ".gitignore"), "contract.json\ndrift\n", "utf8");
    await expect(resolveFrozenCodeIdentity({
      checkoutRoot: fixture.root,
      expectedCommitSha7: fixture.head.slice(0, 7),
      env: { ALAYA_BENCH_GATE_CONTRACT_PATH: fixture.contractPath }
    })).rejects.toThrow(/not clean/iu);
  });

  it("rejects untracked and staged worktree changes", async () => {
    const untracked = await cleanRepository();
    await writeFile(join(untracked.root, "untracked.txt"), "drift", "utf8");
    await expect(resolve(untracked)).rejects.toThrow(/not clean/iu);

    const staged = await cleanRepository();
    await writeFile(join(staged.root, ".gitignore"), "contract.json\nstaged\n", "utf8");
    await git(staged.root, "add", ".gitignore");
    await expect(resolve(staged)).rejects.toThrow(/not clean/iu);
  });

  it("rejects a symlinked contract and unsupported contract versions", async () => {
    const fixture = await cleanRepository();
    const link = join(fixture.root, "contract-link.json");
    await symlink(fixture.contractPath, link);
    const error = await resolve({ ...fixture, contractPath: link }).catch(
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/regular.*non-symlink/iu);
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ELOOP");

    await writeFile(fixture.contractPath, `${JSON.stringify({
      schema_version: 2,
      code: {
        commit_sha: fixture.head,
        commit_sha7: fixture.head.slice(0, 7),
        worktree_state_sha256: fixture.worktreeSha
      }
    })}\n`, "utf8");
    await expect(resolve(fixture)).rejects.toThrow(/invalid frozen gate contract/iu);
  });

  it("rejects a caller commit that differs from measured HEAD", async () => {
    const fixture = await cleanRepository();

    await expect(resolve(fixture, "f".repeat(7)))
      .rejects.toThrow(/caller commit.*HEAD/iu);
  });

  it("refuses expected digests without a measurable contract path", async () => {
    const fixture = await cleanRepository();

    await expect(resolveFrozenCodeIdentity({
      checkoutRoot: fixture.root,
      expectedCommitSha7: fixture.head.slice(0, 7),
      env: { ALAYA_BENCH_GATE_SHA256: "a".repeat(64) }
    })).rejects.toThrow(/require.*contract path/iu);
  });
});

async function cleanRepository(): Promise<{
  readonly root: string;
  readonly head: string;
  readonly worktreeSha: string;
  readonly contractPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "frozen-code-contract-"));
  roots.push(root);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Bench Test");
  await git(root, "config", "user.email", "bench@example.invalid");
  await writeFile(join(root, ".gitignore"), "contract.json\n", "utf8");
  await git(root, "add", ".gitignore");
  await git(root, "commit", "--quiet", "-m", "fixture");
  const head = (await git(root, "rev-parse", "HEAD")).trim();
  const worktreeSha = sha256(`${head}\n`);
  const contractPath = join(root, "contract.json");
  await writeContract(contractPath, head, worktreeSha);
  return { root, head, worktreeSha, contractPath };
}

async function writeContract(path: string, head: string, worktreeSha: string): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schema_version: 1,
    code: {
      commit_sha: head,
      commit_sha7: head.slice(0, 7),
      worktree_state_sha256: worktreeSha
    }
  })}\n`, "utf8");
}

async function git(root: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout;
}

function resolve(
  fixture: Awaited<ReturnType<typeof cleanRepository>>,
  expectedCommitSha7 = fixture.head.slice(0, 7)
) {
  return resolveFrozenCodeIdentity({
    checkoutRoot: fixture.root,
    expectedCommitSha7,
    env: { ALAYA_BENCH_GATE_CONTRACT_PATH: fixture.contractPath }
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
