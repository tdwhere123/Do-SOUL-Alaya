import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { NO_FOLLOW_OPEN_FLAG } from "../../fs/open-flags.js";
import {
  measureGitState,
  type MeasuredGitState
} from "./worktree-state-measure.js";
import { WORKTREE_STATE_ALGORITHM_HEAD_LF } from "./worktree-state-frame.js";

export {
  measureGitState,
  type MeasuredGitState
} from "./worktree-state-measure.js";

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
    schema_version: z.union([z.literal(2), z.literal(3)]),
    kind: z.literal("longmemeval_matrix_promotion_contract"),
    code: FrozenCodeSchema
  }).passthrough()
]);
const SnapshotReuseProducerSchema = z.object({
  commit_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u),
  gate_sha256: Sha256Schema,
  gate_contract_path: z.string().min(1),
  worktree_state_sha256: Sha256Schema,
  worktree_clean: z.literal(true),
  executed_dist: z.object({
    algorithm: z.literal("sha256-reachable-path-file-sha256-v1"),
    sha256: Sha256Schema,
    file_count: z.number().int().positive()
  }).strict()
}).strict();
const SnapshotReuseBindingSchema = z.object({
  manifest_sha256: Sha256Schema,
  producer: SnapshotReuseProducerSchema
}).strict();

export interface FrozenCodeIdentity {
  readonly commitSha: string;
  readonly commitSha7: string;
  readonly gateContractPath: string;
  readonly gateSha256: string;
  readonly worktreeStateSha256: string;
  readonly worktreeStateAlgorithm: typeof WORKTREE_STATE_ALGORITHM_HEAD_LF;
  readonly worktreeClean: true;
}

export type SnapshotReuseBinding = z.infer<typeof SnapshotReuseBindingSchema>;

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
    commitSha: measured.commitSha,
    commitSha7: measured.commitSha7,
    worktreeStateSha256: measured.worktreeStateSha256,
    worktreeStateAlgorithm: WORKTREE_STATE_ALGORITHM_HEAD_LF,
    gateContractPath: contractPath,
    gateSha256,
    worktreeClean: true
  };
}

export async function readFrozenSnapshotReuseBinding(
  env: Readonly<Record<string, string | undefined>>
): Promise<SnapshotReuseBinding> {
  const rawPath = env.ALAYA_BENCH_GATE_CONTRACT_PATH?.trim();
  const expectedSha = env.ALAYA_BENCH_GATE_SHA256?.trim();
  if (!rawPath || !expectedSha) {
    throw new Error("snapshot reuse requires a digest-pinned frozen consumer gate");
  }
  const contractPath = resolve(rawPath);
  const raw = await readContractFile(contractPath);
  assertExpectedSha(expectedSha, sha256(raw), "contract");
  const contract = parseContract(raw, contractPath);
  const binding = (contract as unknown as Record<string, unknown>).snapshot_reuse;
  try {
    return SnapshotReuseBindingSchema.parse(binding);
  } catch (cause) {
    throw new Error("frozen consumer gate lacks a valid snapshot reuse binding", { cause });
  }
}

async function readContractFile(path: string): Promise<Buffer> {
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
    return await open(path, constants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
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

function assertContractMatches(
  code: z.infer<typeof FrozenContractSchema>["code"],
  measured: MeasuredGitState,
  expectedCommitSha7: string
): void {
  if (!measured.worktreeClean) {
    throw new Error("benchmark worktree is not clean");
  }
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
