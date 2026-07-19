import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const FrozenCodeSchema = z.object({
  commit_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u),
  worktree_state_sha256: Sha256Schema
}).passthrough();
const FrozenContractSchema = z.union([
  z.object({
    schema_version: z.literal(1),
    code: FrozenCodeSchema
  }).passthrough(),
  z.object({
    schema_version: z.literal(2),
    kind: z.literal("longmemeval_matrix_promotion_contract"),
    code: FrozenCodeSchema
  }).passthrough()
]);

export interface FrozenCodeIdentity {
  readonly commitSha: string;
  readonly commitSha7: string;
  readonly gateContractPath: string;
  readonly gateSha256: string;
  readonly worktreeStateSha256: string;
  readonly worktreeClean: true;
}

export async function resolveFrozenCodeIdentity(input: {
  readonly checkoutRoot: string;
  readonly expectedCommitSha7: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<FrozenCodeIdentity | null> {
  const rawPath = input.env.ALAYA_BENCH_GATE_CONTRACT_PATH?.trim();
  if (!rawPath) {
    assertNoUnmeasuredExpectations(input.env);
    return null;
  }
  const contractPath = resolve(rawPath);
  const raw = await readContractFile(contractPath);
  const contract = parseContract(raw, contractPath);
  const measured = await measureGitState(input.checkoutRoot);
  assertContractMatches(contract.code, measured, input.expectedCommitSha7);
  const gateSha256 = sha256(raw);
  assertExpectedSha(input.env.ALAYA_BENCH_GATE_SHA256, gateSha256, "contract");
  assertExpectedSha(
    input.env.ALAYA_BENCH_WORKTREE_STATE_SHA256,
    measured.worktreeStateSha256,
    "worktree"
  );
  return {
    ...measured,
    gateContractPath: contractPath,
    gateSha256,
    worktreeClean: true
  };
}

async function readContractFile(path: string): Promise<Buffer> {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("frozen gate contract no-follow validation is unavailable");
  }
  const handle = await openContractHandle(path);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("frozen gate contract path must be a regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function openContractHandle(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw new Error(
      "frozen gate contract path must be a regular non-symlink file",
      { cause }
    );
  }
}

function parseContract(raw: Buffer, path: string): z.infer<typeof FrozenContractSchema> {
  try {
    return FrozenContractSchema.parse(JSON.parse(raw.toString("utf8")) as unknown);
  } catch (cause) {
    throw new Error(`invalid frozen gate contract at ${path}`, { cause });
  }
}

async function measureGitState(checkoutRoot: string): Promise<{
  readonly commitSha: string;
  readonly commitSha7: string;
  readonly worktreeStateSha256: string;
}> {
  const [rootResult, headResult, statusResult] = await Promise.all([
    execFileAsync("git", ["-C", checkoutRoot, "rev-parse", "--show-toplevel"]),
    execFileAsync("git", ["-C", checkoutRoot, "rev-parse", "HEAD"]),
    execFileAsync("git", [
      "-C", checkoutRoot, "status", "--porcelain=v1", "--untracked-files=normal"
    ])
  ]);
  if (resolve(rootResult.stdout.trim()) !== resolve(checkoutRoot)) {
    throw new Error("provenance checkout root is not the current git worktree root");
  }
  const commitSha = headResult.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(commitSha)) throw new Error("git HEAD is not a commit SHA");
  if (statusResult.stdout.length > 0) throw new Error("benchmark worktree is not clean");
  return {
    commitSha,
    commitSha7: commitSha.slice(0, 7),
    worktreeStateSha256: sha256(headResult.stdout + statusResult.stdout)
  };
}

function assertContractMatches(
  code: z.infer<typeof FrozenContractSchema>["code"],
  measured: Awaited<ReturnType<typeof measureGitState>>,
  expectedCommitSha7: string
): void {
  if (code.commit_sha !== measured.commitSha || code.commit_sha7 !== measured.commitSha7) {
    throw new Error("frozen gate contract does not match measured git HEAD");
  }
  if (expectedCommitSha7 !== measured.commitSha7) {
    throw new Error("caller commit does not match measured git HEAD");
  }
  if (code.worktree_state_sha256 !== measured.worktreeStateSha256) {
    throw new Error("frozen gate contract does not match measured clean worktree state");
  }
}

function assertNoUnmeasuredExpectations(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (env.ALAYA_BENCH_GATE_SHA256 !== undefined ||
      env.ALAYA_BENCH_WORKTREE_STATE_SHA256 !== undefined) {
    throw new Error("benchmark code digest expectations require a frozen contract path");
  }
}

function assertExpectedSha(
  raw: string | undefined,
  measured: string,
  label: string
): void {
  if (raw === undefined) return;
  const expected = Sha256Schema.parse(raw.trim().toLowerCase());
  if (expected !== measured) {
    throw new Error(`environment ${label} identity does not match fresh measurement`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
