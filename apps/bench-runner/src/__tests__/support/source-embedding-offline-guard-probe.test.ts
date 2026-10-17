import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const nativeSpawnSync = childProcess.spawnSync.bind(childProcess);
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
type AllocationTotals = { sends: number; source_inputs: number; utf8_bytes: number };
type AllocationCheckpoint = {
  input_cap: number | null; input_cap_source: string; input_cap_scope: string;
  cumulative_input_cap: number | null; cumulative_input_cap_source: string; cumulative_input_reserved: number;
  explicit_cumulative_input_cap: number | null;
  source_allocation: { status: string; scope?: string; source_inputs?: number; utf8_bytes?: number };
  allocation_usage: { reserved: AllocationTotals; dispatched: AllocationTotals; blocked: AllocationTotals;
    forward_unknown: AllocationTotals; inference_occupancy: string };
};
type GuardReceipt = AllocationCheckpoint & {
  reason: string;
  reported_outcome: string | null;
  preload_specifier: string;
  configured_child_exec_argv: string[];
  blocked_sends: Array<{ op: string; inputs: number; texts: number }>;
  dispatched_sends: Array<{ op: string }>;
  reserved_sends: Array<{ input_cap: number; input_cap_source: string }>;
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
  reports: Array<AllocationCheckpoint & { phase: string; pid: number; preload_specifier?: string;
    exec_argv?: string[]; local_responses?: number; warmup: GuardReceipt["warmup"] }>;
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
  expect(receipt.cumulative_input_reserved).toBe(3);
  expect(receipt.reserved_sends.map(row => [row.input_cap, row.input_cap_source])).toEqual([[2, "default"], [3, "explicit"]]);
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

// Substitute only the application entry before installing the existing owner.
// Its fork, preload, serialization, child ingress and receipts use actual Node IPC.
const ipcProbeProgram = `
import cp from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [specifier, fixture, productionChild, dir, rawConfig] = process.argv.slice(1);
const config = JSON.parse(rawConfig);
const nativeFork = cp.fork;
let rawSend;
const nativeCalls = [];
cp.fork = (_script, args, options) => {
  const handle = nativeFork(fixture, args, options);
  rawSend = handle.send.bind(handle);
  handle.send = (message, ...rest) => {
    nativeCalls.push(message.op);
    if (config.throwForward && message.op === "embed_source") throw new Error("fixture unknown forward");
    return rawSend(message, ...rest);
  };
  return handle;
};
const { isolation } = await import(specifier);
const errors = [];
if (config.reconfigure) {
  const raised = new URL(specifier);
  raised.searchParams.set("source_input_cap", "99");
  raised.searchParams.set("source_utf8_byte_cap", "9999");
  try { await import(raised.href); } catch (error) { errors.push(error.message); }
}
if (config.mutateEnv) process.env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP = "3";
const handle = cp.fork(productionChild, [], { execArgv: [], env: process.env, silent: true });
handle.stderr.resume();
const observed = [];
handle.on("message", message => { if (message.ok === true) observed.push(message); });
await new Promise(resolve => {
  const installed = message => {
    if (message.kind !== "alaya-source-embedding-offline-guard" || message.phase !== "installed") return;
    handle.off("message", installed);
    resolve();
  };
  handle.on("message", installed);
});
let getterReads = 0;
for (const [index, offered] of config.messages.entries()) {
  const message = { id: index + 1, ...offered };
  if (config.captureGetter && index === 0) {
    message.inputs = [{ input_id: "getter", get text() { getterReads += 1; return getterReads === 1 ? "é" : "changed"; } }];
  }
  let done;
  const replied = new Promise(resolve => { done = resolve; });
  const onMessage = reply => { if (reply.id === message.id && typeof reply.ok === "boolean") done(); };
  const onExit = () => done();
  handle.on("message", onMessage);
  handle.once("exit", onExit);
  try {
    (config.bypassParent ? rawSend : handle.send.bind(handle))(message);
    await replied;
  } catch (error) { errors.push(error.message); }
  finally { handle.off("message", onMessage); handle.off("exit", onExit); }
  if (handle.exitCode !== null || handle.signalCode !== null) break;
}
await isolation.close();
const read = name => JSON.parse(readFileSync(join(dir, name), "utf8"));
console.log(JSON.stringify({ errors, observed, nativeCalls, getterReads,
  parent: read("parent-guard-receipt.json"), child: read("child-guard-receipt.json") }));
// Cleanup has confirmed child exit; do not retain its losing timeout promise.
process.stdout.write("", () => process.exit());
`;

it("proves installed references and unused frozen caps rather than accepting a marker or replaced guard", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-guard-active-inspection-"));
  try {
    const url = new URL(preload.href); url.search = "source_input_cap=1&source_utf8_byte_cap=4";
    const script = join(directory, "inspect.mjs");
    writeFileSync(script, `import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      const { isolation } = await import(${JSON.stringify(url.href)});
      const policy = { preload: ${JSON.stringify(url.href)}, inputs: 1, bytes: 4, unused: true };
      assert(isolation.assertActive(policy).installed_references > 20);
      assert.throws(() => isolation.assertActive({ ...policy, bytes: 5 }));
      const guarded = childProcess.fork;
      childProcess.fork = () => { throw new Error("replaced fork must never dispatch"); };
      assert.throws(() => isolation.assertActive(policy), /not active/);
      childProcess.fork = guarded;
      isolation.assertActive(policy);
      isolation.restore();
      assert.throws(() => isolation.assertActive(policy), /not active/);
    `);
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP;
    delete env.ALAYA_SOURCE_EMBEDDING_OFFLINE_CHILD;
    const result = nativeSpawnSync(process.execPath, ["--import", url.href, script], { env, encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

type BoundaryOptions = {
  query?: string; perSend?: string; bypassParent?: boolean; throwForward?: boolean;
  reconfigure?: boolean; mutateEnv?: boolean; captureGetter?: boolean;
};
type BoundaryResult = {
  errors: string[]; observed: Array<{ id: number; inputs?: Array<{ text: string }> }>;
  nativeCalls: string[]; getterReads: number; parent: GuardReceipt; child: ChildGuardReceipt;
};
function runBoundary(messages: Record<string, unknown>[], options: BoundaryOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "source-embedding-allocation-ipc-"));
  try {
    const fixture = join(dir, "source-input-observer.mjs");
    writeFileSync(fixture, `process.on("message", message => {
      if (message.op === "close") process.exit(0);
      process.send({ id: message.id, ok: true, op: message.op, inputs: message.inputs });
    });`, "utf8");
    const url = new URL(preload.href);
    url.search = options.query ?? "";
    const env: NodeJS.ProcessEnv = { ...process.env, ALAYA_SOURCE_EMBEDDING_OFFLINE_GUARD_RECEIPT_DIR: dir };
    delete env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP;
    delete env.ALAYA_SOURCE_EMBEDDING_OFFLINE_CHILD;
    delete env.NODE_OPTIONS;
    if (options.perSend !== undefined) env.ALAYA_SOURCE_EMBEDDING_OFFLINE_INPUT_CAP = options.perSend;
    const result = nativeSpawnSync(process.execPath, ["--input-type=module", "--eval", ipcProbeProgram,
      url.href, fixture, productionChild, dir, JSON.stringify({ ...options, messages })], {
      env, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024
    });
    expect(result.error, result.stderr).toBeUndefined();
    return { status: result.status, stderr: result.stderr,
      value: result.stdout.trim() ? JSON.parse(result.stdout) as BoundaryResult : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const allocation = (inputs: number, bytes: number) => `source_input_cap=${inputs}&source_utf8_byte_cap=${bytes}`;
const source = (...texts: string[]) => ipc("embed_source", {
  inputs: texts.map((text, index) => ({ input_id: String(index), text }))
});
function checkedBoundary(messages: Record<string, unknown>[], options: BoundaryOptions = {}): BoundaryResult {
  const result = runBoundary(messages, options);
  expect(result.value, result.stderr).not.toBeNull();
  const value = result.value!;
  expect(value.parent.cleanup).toBe("confirmed");
  expect(value.parent.children).toHaveLength(1);
  const installed = value.child.reports[0]!;
  expect(installed.phase).toBe("installed");
  expect(installed.preload_specifier).toBe(value.parent.preload_specifier);
  expect(installed.exec_argv).toEqual(["--import", value.parent.preload_specifier]);
  expect(installed.source_allocation).toEqual(value.parent.source_allocation);
  return value;
}

it("reserves one cumulative input and blocks the next single-input send before parent forwarding", () => {
  const value = checkedBoundary([source("a"), source("b")], { query: allocation(1, 100) });
  expect(value.observed).toHaveLength(1);
  expect(value.nativeCalls.filter(op => op === "embed_source")).toHaveLength(1);
  expect(value.errors).toEqual([expect.stringContaining("cumulative Source input cap")]);
  expect(value.parent.allocation_usage.reserved).toEqual({ sends: 1, source_inputs: 1, utf8_bytes: 1 });
  expect(value.parent.allocation_usage.blocked.source_inputs).toBe(1);
  expect(value.child.reports.at(-1)!.allocation_usage.reserved.source_inputs).toBe(1);
});

it("accepts an exact cumulative cap across batches and many single sends then blocks the next", () => {
  const value = checkedBoundary([source("a", "b"), source("c"), source("d"), source("e")], {
    query: allocation(4, 4)
  });
  expect(value.observed).toHaveLength(3);
  expect(value.parent.allocation_usage.reserved).toEqual({ sends: 3, source_inputs: 4, utf8_bytes: 4 });
  expect(value.parent.allocation_usage.dispatched.source_inputs).toBe(4);
  expect(value.child.reports.at(-1)!.allocation_usage.reserved).toEqual({ sends: 3, source_inputs: 4, utf8_bytes: 4 });
  expect(value.errors).toHaveLength(1);
});

it.each([false, true])("charges UTF-8 bytes cumulatively before %s parent-bypass forwarding", bypassParent => {
  const value = checkedBoundary([source("é"), source("𠮷"), source("x")], {
    query: allocation(10, 6), bypassParent
  });
  expect(value.observed).toHaveLength(2);
  const checkpoint = bypassParent ? value.child.reports.at(-1)! : value.parent;
  expect(checkpoint.allocation_usage.reserved).toEqual({ sends: 2, source_inputs: 2, utf8_bytes: 6 });
  expect(checkpoint.allocation_usage.blocked.utf8_bytes).toBe(1);
  if (bypassParent) expect(value.parent.allocation_usage.reserved.source_inputs).toBe(0);
  else expect(value.errors).toEqual([expect.stringContaining("UTF-8 byte cap")]);
});

it("enforces the cumulative input allocation independently at the actual child ingress", () => {
  const value = checkedBoundary([source("a"), source("b")], { query: allocation(1, 100), bypassParent: true });
  expect(value.observed).toHaveLength(1);
  expect(value.parent.allocation_usage.reserved.source_inputs).toBe(0);
  expect(value.child.reports.at(-1)!.allocation_usage.reserved.source_inputs).toBe(1);
  expect(value.child.reports.at(-1)!.allocation_usage.blocked.source_inputs).toBe(1);
  expect(value.child.children[0]?.code).toBe(1);
});

it.each([false, true])("allows bind and warmup with zero allocation but denies inputs with parent bypass %s", bypassParent => {
  const value = checkedBoundary([ipc("warmup"), ipc("bind_source"), source("a"), ipc("embed", { texts: ["b"] })], {
    query: allocation(0, 0), bypassParent
  });
  expect(value.observed).toHaveLength(2);
  expect(value.errors).toHaveLength(bypassParent ? 0 : 2);
  const checkpoint = bypassParent ? value.child.reports.at(-1)! : value.parent;
  expect(checkpoint.allocation_usage.blocked.source_inputs).toBe(bypassParent ? 1 : 2);
  expect(value.parent.allocation_usage.reserved.source_inputs).toBe(0);
  expect(checkpoint.warmup).toEqual({ attempted: 1, dispatched: 1, model_execution_work: "unknown" });
  expect(checkpoint.allocation_usage.inference_occupancy).toBe("unknown");
  expect(value.child.reports.at(-1)!.warmup.model_execution_work).toBe("unknown");
});

it("does not grant ordinary embedding permission at child ingress with an explicit Source allocation", () => {
  const value = checkedBoundary([ipc("embed", { texts: ["ordinary"] })], { query: allocation(1, 100), bypassParent: true });
  expect(value.observed).toEqual([]);
  expect(value.child.reports.at(-1)!.allocation_usage.reserved.source_inputs).toBe(0);
  expect(value.child.reports.at(-1)!.allocation_usage.blocked.source_inputs).toBe(1);
});

it("does not refund a throwing forward or dispatch a retry from its unknown reservation", () => {
  const value = checkedBoundary([source("é"), source("x")], { query: allocation(1, 2), throwForward: true });
  expect(value.observed).toEqual([]);
  expect(value.nativeCalls.filter(op => op === "embed_source")).toHaveLength(1);
  expect(value.errors).toEqual(["fixture unknown forward", expect.stringContaining("cumulative Source input cap")]);
  expect(value.parent.allocation_usage).toMatchObject({
    reserved: { sends: 1, source_inputs: 1, utf8_bytes: 2 }, dispatched: { source_inputs: 0 },
    forward_unknown: { sends: 1, source_inputs: 1, utf8_bytes: 2 }, inference_occupancy: "unknown"
  });
});

it("captures the forwarded Source text once before accounting, validation and IPC serialization", () => {
  const value = checkedBoundary([source("unused")], { query: allocation(1, 2), captureGetter: true });
  expect(value.getterReads).toBe(1);
  expect(value.observed[0]!.inputs).toEqual([{ input_id: "getter", text: "é" }]);
  expect(value.parent.allocation_usage.reserved.utf8_bytes).toBe(2);
  expect(value.child.reports.at(-1)!.allocation_usage.reserved.utf8_bytes).toBe(2);
});

it("cannot increase or reset an allocation by reimporting or changing the legacy env midrun", () => {
  const value = checkedBoundary([source("a", "b", "c"), source("a"), source("b")], {
    query: allocation(1, 10), reconfigure: true, mutateEnv: true
  });
  expect(value.observed).toHaveLength(1);
  expect(value.errors).toEqual([expect.stringContaining("already installed"),
    expect.stringContaining("pre-send inference input cap"), expect.stringContaining("cumulative Source input cap")]);
  expect(value.parent.input_cap).toBe(2);
  expect(value.parent.source_allocation).toEqual({ status: "configured", scope: "per_process", source_inputs: 1, utf8_bytes: 10 });
});

it.each([undefined, "2", "3"].flatMap(perSend => [false, true].map(bypassParent => ({ perSend, bypassParent }))))(
  "preserves default/explicit $perSend ceilings with parent bypass $bypassParent", ({ perSend, bypassParent }) => {
  const messages = [source("a", "b"), source("c"), source("d")];
  const value = checkedBoundary(messages, { perSend, bypassParent });
  expect(value.observed).toHaveLength(perSend === undefined ? 3 : perSend === "2" ? 1 : 2);
  expect(value.parent.source_allocation).toEqual({ status: "unconfigured" });
  expect(value.parent.input_cap_scope).toBe("per_send");
  expect(value.parent.cumulative_input_cap).toBe(perSend === undefined ? null : Number(perSend));
  expect(value.parent.cumulative_input_cap_source).toBe(perSend === undefined ? "unconfigured" : "explicit");
});

it.each([false, true])("enforces the smaller allocation/explicit ceiling with parent bypass %s", bypassParent => {
  for (const { perSend, allocated, expected } of [
    { perSend: "2", allocated: 3, expected: 2 },
    { perSend: "3", allocated: 4, expected: 3 },
    { perSend: "3", allocated: 2, expected: 2 }
  ]) {
    const value = checkedBoundary(Array.from({ length: expected + 1 }, () => source("a")), {
      query: allocation(allocated, 100), perSend, bypassParent
    });
    expect(value.observed).toHaveLength(expected);
    expect(value.errors).toEqual(bypassParent ? [] : [expect.stringContaining("cumulative Source input cap")]);
    for (const checkpoint of [value.parent, value.child.reports.at(-1)!]) {
      expect(checkpoint.input_cap).toBe(Number(perSend));
      expect(checkpoint.explicit_cumulative_input_cap).toBe(Number(perSend));
      expect(checkpoint.source_allocation.source_inputs).toBe(allocated);
      expect(checkpoint.cumulative_input_cap).toBe(expected);
      expect(checkpoint.cumulative_input_cap_source).toBe("allocation_and_explicit");
    }
    const checkpoint = bypassParent ? value.child.reports.at(-1)! : value.parent;
    expect(checkpoint.allocation_usage.blocked.source_inputs).toBe(1);
    expect(checkpoint.cumulative_input_reserved).toBe(expected);
  }
});

it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992", "", "1e3", "nope"])(
  "rejects malformed finite allocations before the application entry: %s", raw => {
    for (const query of [`source_input_cap=${raw}&source_utf8_byte_cap=10`, `source_input_cap=10&source_utf8_byte_cap=${raw}`]) {
      const result = runBoundary([], { query });
      expect(result.status).toBe(1);
      expect(result.value).toBeNull();
      expect(result.stderr).toContain("Invalid offline Source allocation");
    }
  }
);

it.each(["source_input_cap=1", "source_utf8_byte_cap=1", "source_input_cap=1&source_input_cap=2&source_utf8_byte_cap=10"])(
  "rejects missing or repeated allocation fields before the application entry: %s", query => {
    const result = runBoundary([], { query });
    expect(result.status).toBe(1);
    expect(result.value).toBeNull();
    expect(result.stderr).toContain("Invalid offline Source allocation");
  }
);
