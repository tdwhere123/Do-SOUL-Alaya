import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const forkDescriptor = Object.getOwnPropertyDescriptor(childProcess, "fork")!;
const execFileDescriptor = Object.getOwnPropertyDescriptor(childProcess, "execFile")!;
const execFileSyncDescriptor = Object.getOwnPropertyDescriptor(childProcess, "execFileSync")!;
const nativeSends: unknown[] = [];
const gitEnvs: Array<Record<string, string | undefined>> = [];
const pidKills: Array<{ pid: number; signal?: string }> = [];
const nativeProcessKill = process.kill.bind(process);

process.kill = ((pid: number, signal?: string) => {
  pidKills.push({ pid, signal });
  throw new Error(`guard probe forbids pid kill (${pid})`);
}) as typeof process.kill;

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number; connected: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null;
    send: (message: unknown, ...rest: unknown[]) => boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.pid = 42_424_242;
  child.connected = true;
  child.exitCode = null;
  child.signalCode = null;
  child.send = (message, ...rest) => {
    nativeSends.push(message);
    const callback = rest.find(value => typeof value === "function") as ((error: Error | null) => void) | undefined;
    callback?.(null);
    return true;
  };
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode !== null) return true;
    child.exitCode = 0;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, signal);
    return true;
  };
  return child;
}

Object.defineProperty(childProcess, "fork", {
  ...forkDescriptor,
  value: function mockFork() { return createFakeChild(); }
});
function mockExecFile(
  _command: string,
  _args: string[] | undefined,
  options: { env?: Record<string, string | undefined> } | undefined,
  ...rest: unknown[]
) {
  gitEnvs.push({ ...(options?.env ?? {}) });
  const callback = rest.find(value => typeof value === "function") as
    ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
  callback?.(null, "", "");
  return new EventEmitter();
}
Object.defineProperty(childProcess, "execFile", { ...execFileDescriptor, value: mockExecFile });
Object.defineProperty(childProcess, "execFileSync", {
  ...execFileSyncDescriptor,
  value: function mockExecFileSync(
    _command: string,
    _args: string[] | undefined,
    options: { env?: Record<string, string | undefined> } | undefined
  ) {
    gitEnvs.push({ ...(options?.env ?? {}) });
    return Buffer.from("");
  }
});
syncBuiltinESMExports();

const receiptDir = mkdtempSync(join(tmpdir(), "source-embedding-offline-guard-receipt-"));
process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_ALLOW_GIT = "1";
process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_GUARD_RECEIPT_DIR = receiptDir;
delete process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP;

const preload = new URL(
  "../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-source-embedding-offline-preload.mjs",
  import.meta.url
);
const productionChild = fileURLToPath(new URL("../../../dist/embedding-recall/local-onnx-process/child.js", preload));
const { isolation }: { isolation: Isolation } = await import(/* @vite-ignore */ preload.href);

type GuardedChild = EventEmitter & { send: (message: unknown) => boolean; pid: number };
type GuardReceiptChild = {
  pid: number | null; script: string | null; preload: string | null;
  exited: boolean; code: number | null; signal: string | null;
  exit_confirmed: boolean; exit_confirmed_scope: string; handle_owned: boolean;
};
type GuardReceipt = {
  reason: string;
  reported_outcome: string | null;
  preload_specifier: string;
  configured_child_exec_argv: string[];
  blocked_sends: Array<{ op: string; inputs: number; texts: number }>;
  dispatched_sends: Array<{ op: string }>;
  warmup: { attempted: number; dispatched: number; model_execution_work: string };
  cleanup: string;
  children: GuardReceiptChild[];
  local_responses: number;
  observed_application_replies: number;
  read_only_git: Array<{ command: string; credential_environment_count: number }>;
};
type ChildGuardReceipt = {
  reason: string;
  reported_outcome: string | null;
  reports: Array<{ phase: string; pid: number; preload_specifier?: string; exec_argv?: string[]; local_responses?: number }>;
  children: GuardReceiptChild[];
};
type Isolation = {
  children: Array<{ pid?: number; preload?: string; exited?: boolean; code?: number | null; signal?: string | null }>;
  childReports: Array<{ phase: string; local_responses?: number }>;
  requests: Array<{ op: string }>;
  blockedSends: GuardReceipt["blocked_sends"];
  readOnlyGitCalls: GuardReceipt["read_only_git"];
  writeReceipts(reason: string): void;
  restore(): void;
  close(): Promise<void>;
};

let child: GuardedChild | null = null;

function ipc(op: string, extra: Record<string, unknown> = {}) {
  return { id: 1, op, modelId: "fixture", cacheDir: null, schemaVersion: 1, ...extra };
}

function spawnGuardedChild(): GuardedChild {
  if (child === null) {
    child = childProcess.fork(productionChild, [], { execArgv: [] }) as unknown as GuardedChild;
  }
  expect(isolation.children).toHaveLength(1);
  return child;
}

function readGuardReceipts(): { parent: GuardReceipt; child: ChildGuardReceipt } {
  return {
    parent: JSON.parse(readFileSync(join(receiptDir, "parent-guard-receipt.json"), "utf8")) as GuardReceipt,
    child: JSON.parse(readFileSync(join(receiptDir, "child-guard-receipt.json"), "utf8")) as ChildGuardReceipt
  };
}

afterAll(async () => {
  try {
    await isolation.close();
    expect(pidKills).toEqual([]);
    expect(isolation.children[0]?.exited).toBe(true);
  } finally {
    process.kill = nativeProcessKill;
    Object.defineProperty(childProcess, "fork", forkDescriptor);
    Object.defineProperty(childProcess, "execFile", execFileDescriptor);
    Object.defineProperty(childProcess, "execFileSync", execFileSyncDescriptor);
    syncBuiltinESMExports();
  }
});

it("records the actual sanitized git credential environment census", () => {
  childProcess.execFile("git", ["worktree", "list", "--porcelain"], {
    env: {
      PATH: "/usr/bin",
      FIXTURE_SECRET: "redacted-fixture",
      FIXTURE_TOKEN: "redacted-fixture",
      GIT_TERMINAL_PROMPT: "1"
    }
  });
  const passed = gitEnvs.at(-1)!;
  expect(passed.FIXTURE_SECRET).toBeUndefined();
  expect(passed.FIXTURE_TOKEN).toBeUndefined();
  expect(passed.GIT_CONFIG_NOSYSTEM).toBe("1");
  const remaining = Object.keys(passed).filter(key => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)).length;
  expect(isolation.readOnlyGitCalls.at(-1)).toMatchObject({
    command: "git", credential_environment_count: remaining
  });
  expect(remaining).toBe(0);
});

it("does not treat a missing input cap as unlimited and preserves two-input sends", () => {
  const handle = spawnGuardedChild();
  delete process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP;
  const before = nativeSends.length;
  expect(() => handle.send(ipc("embed_source", { inputs: ["a", "b", "c"] }))).toThrow(/refused/u);
  expect(nativeSends.length).toBe(before);
  handle.send(ipc("embed_source", { inputs: ["a", "b"] }));
  expect(nativeSends.at(-1)).toMatchObject({ op: "embed_source", inputs: ["a", "b"] });
});

it("denies a fourth inference input and embed.texts before native send", () => {
  const handle = spawnGuardedChild();
  process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP = "3";
  handle.send(ipc("warmup"));
  const afterWarmup = nativeSends.length;
  expect(() => handle.send(ipc("embed_source", { inputs: ["a", "b", "c", "d"] }))).toThrow(/refused/u);
  expect(nativeSends.length).toBe(afterWarmup);
  expect(() => handle.send(ipc("embed", { texts: ["legacy"] }))).toThrow(/refused/u);
  expect(nativeSends.length).toBe(afterWarmup);
  handle.send(ipc("embed_source", { inputs: ["a", "b", "c"] }));
  expect(nativeSends.at(-1)).toMatchObject({ op: "embed_source", inputs: ["a", "b", "c"] });
  const afterThree = nativeSends.length;
  expect(() => handle.send(ipc("embed_source", { inputs: ["fourth"] }))).toThrow(/refused/u);
  expect(nativeSends.length).toBe(afterThree);
  expect(isolation.blockedSends.some(row => row.op === "embed_source" && row.inputs === 4)).toBe(true);
  expect(isolation.blockedSends.some(row => row.op === "embed" && row.texts === 1)).toBe(true);
  expect(isolation.requests.filter(row => row.op === "warmup")).toHaveLength(1);
});

it("persists parent and child guard receipts after a failed probe without the fixture temp tree", () => {
  const handle = spawnGuardedChild();
  const work = mkdtempSync(join(tmpdir(), "source-embedding-offline-guard-work-"));
  expect(receiptDir.startsWith(work)).toBe(false);
  try {
    handle.send(ipc("embed_source", { inputs: ["a", "b", "c", "d"] }));
    throw new Error("expected pre-send denial");
  } catch (error) {
    expect(String(error)).toMatch(/refused/u);
  } finally {
    rmSync(work, { recursive: true, force: true });
    isolation.writeReceipts("probe_failure");
  }
  expect(existsSync(work)).toBe(false);
  const parentPath = join(receiptDir, "parent-guard-receipt.json");
  const childPath = join(receiptDir, "child-guard-receipt.json");
  expect(existsSync(parentPath)).toBe(true);
  expect(existsSync(childPath)).toBe(true);
  const body = readFileSync(parentPath, "utf8");
  expect(body).not.toMatch(/FIXTURE_SECRET|FIXTURE_TOKEN|redacted-fixture|legacy/u);
  const receipts = readGuardReceipts();
  const receipt = receipts.parent;
  expect(isolation.children[0]?.exited).toBe(false);
  expect(receipt.cleanup).toBe("exit_unknown");
  expect(receipt.reported_outcome).toBe("probe_failure");
  expect(receipt.reason).toBe("probe_failure");
  const recordedPreload = isolation.children[0]?.preload;
  expect(recordedPreload).toBe(preload.href);
  expect(receipt.preload_specifier).toBe(recordedPreload);
  expect(receipt.configured_child_exec_argv).toEqual(["--import", recordedPreload]);
  expect(receipt.children[0]).toMatchObject({
    preload: recordedPreload, script: productionChild, exited: false, exit_confirmed: false,
    exit_confirmed_scope: "process_exit_observed_not_handler_completion", handle_owned: true
  });
  expect(receipt).not.toHaveProperty("responses");
  expect(receipt).not.toHaveProperty("installed_before_entry");
  expect(receipt).not.toHaveProperty("shared_credential_guard");
  expect(receipt.local_responses).toBe(0);
  expect(receipts.child.reported_outcome).toBe("probe_failure");
  expect(receipts.child.reason).toBe("probe_failure");
  expect(receipt.warmup.model_execution_work).toBe("unknown");
  expect(receipt.blocked_sends.some(row => row.op === "embed")).toBe(true);
  expect(receipt.dispatched_sends.some(row => row.op === "warmup")).toBe(true);
  expect(receipt.read_only_git[0]?.credential_environment_count).toBe(0);
});

it("refuses sync restore while the recorded child is live", () => {
  expect(isolation.children[0]?.exited).toBe(false);
  expect(() => isolation.restore()).toThrow(/live/u);
  expect(isolation.children[0]?.exited).toBe(false);
});

it("counts parent-observed application replies separately from local zeros and guard messages", () => {
  const handle = spawnGuardedChild();
  const childPid = handle.pid;
  handle.emit("message", {
    kind: "alaya-source-embedding-offline-guard",
    phase: "installed",
    pid: childPid,
    preload_specifier: preload.href,
    exec_argv: ["--import", preload.href],
    local_responses: 0,
    credential_environment_count: 0,
    transport_guards: [],
    violations: []
  });
  handle.emit("message", { id: 1, ok: true });
  handle.emit("message", {
    kind: "alaya-source-embedding-offline-guard",
    phase: "application_response",
    pid: childPid,
    preload_specifier: preload.href,
    exec_argv: ["--import", preload.href],
    local_responses: 1,
    credential_environment_count: 0,
    transport_guards: [],
    violations: []
  });
  isolation.writeReceipts("probe_failure");
  const receipts = readGuardReceipts();
  expect(receipts.parent.cleanup).toBe("exit_unknown");
  expect(receipts.parent.local_responses).toBe(0);
  expect(receipts.parent.observed_application_replies).toBe(1);
  expect(receipts.parent.local_responses).not.toBe(receipts.parent.observed_application_replies);
  expect(isolation.childReports.map(row => row.phase)).toEqual(["installed", "application_response"]);
  expect(receipts.child.reports.map(row => row.local_responses)).toEqual([0, 1]);
  expect(receipts.child.reports[0]?.exec_argv).toEqual(["--import", preload.href]);
  expect(receipts.child.reports[0]?.preload_specifier).toBe(preload.href);
});

it("retains reported outcome after close restore and confirms process exit only", async () => {
  expect(isolation.children[0]?.exited).toBe(false);
  isolation.writeReceipts("probe_failure");
  await isolation.close();
  const receipts = readGuardReceipts();
  expect(receipts.parent.reported_outcome).toBe("probe_failure");
  expect(receipts.parent.reason).toBe("restore");
  expect(receipts.parent.cleanup).toBe("confirmed");
  expect(receipts.parent.children[0]).toMatchObject({
    preload: preload.href, exited: true, exit_confirmed: true, code: 0, signal: "SIGTERM",
    exit_confirmed_scope: "process_exit_observed_not_handler_completion", handle_owned: true
  });
  expect(receipts.child.reported_outcome).toBe("probe_failure");
  expect(receipts.child.reason).toBe("restore");
  expect(receipts.child.children[0]).toMatchObject({
    exited: true, exit_confirmed: true, code: 0, signal: "SIGTERM",
    exit_confirmed_scope: "process_exit_observed_not_handler_completion"
  });
});
