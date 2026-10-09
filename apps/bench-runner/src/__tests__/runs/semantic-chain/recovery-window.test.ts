import { afterAll, afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolation = await vi.hoisted(async () => {
  const guard = "../../../../../core-daemon/src/__tests__/support/provider-free-cli.mjs";
  await import(guard);
  const [{ default: http }, { default: https }, { default: net }, { default: tls },
    { default: http2 }, { default: dgram }, { default: fs }, { default: fsp }, { syncBuiltinESMExports }] =
    await Promise.all([import("node:http"), import("node:https"), import("node:net"), import("node:tls"),
      import("node:http2"), import("node:dgram"), import("node:fs"), import("node:fs/promises"), import("node:module")]);
  const restores: (() => void)[] = [], forbidden: string[] = [];
  function block(owner: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    Object.defineProperty(owner, key, { ...descriptor, value: () => {
      forbidden.push(key); throw new Error(`Provider-free recovery test forbids ${key}`);
    } });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  for (const owner of [http, https]) for (const key of ["request", "get"]) block(owner, key);
  for (const key of ["connect", "createConnection"]) block(net, key);
  block(net.Socket.prototype, "connect"); block(tls, "connect"); block(http2, "connect");
  block(dgram, "createSocket"); block(globalThis, "fetch");
  const environment = process.env;
  process.env = new Proxy(environment, { get(target, key) {
    if (typeof key === "string" && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)) {
      forbidden.push("credential environment"); throw new Error("Credential environment access forbidden");
    }
    return Reflect.get(target, key);
  } });
  restores.push(() => { process.env = environment; });
  for (const owner of [fs, fsp]) for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor?.value === undefined) continue;
    Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
      apply(target, receiver, args) {
        if (/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(String(args[0]))) {
          forbidden.push("credential file"); throw new Error("Credential file access forbidden");
        }
        return Reflect.apply(target, receiver, args);
      }
    }) });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  syncBuiltinESMExports();
  return { forbidden, restore: () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
});

import { declareRecoveryInitialQueryPreparation } from "../../../runs/semantic-chain/recovery-window.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => { isolation.restore(); expect(isolation.forbidden).toEqual([]); });

function freezeInput(chainExtra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "recovery-window-")); roots.push(root);
  const snapshot = join(root, "sealed.sqlite");
  writeFileSync(snapshot, "sealed");
  return { root, value: {
    native_snapshot_path: snapshot, population: "originals", source_model: "gemini-3.1-flash-lite",
    source_request_profile: "gemini-3.1-minimal-v1", source_cache_root: join(root, "h-cache"),
    recorded_at: "2026-09-21T01:00:00.000Z", producer_commit: "a".repeat(40),
    allowance: { total_work_units: 30, total_memory_bytes: 30, read_work_units: 10, read_memory_bytes: 10,
      max_input_bytes_per_read: 32 * 1024 * 1024, max_read_admissions: 2, max_effects: 1 },
    chain: {
      implementation_revision: "a".repeat(40), interpretation_clock: "2026-09-21T01:00:00.000Z",
      workspace_id: "ws", run_id: "run",
      query_workset: { contract: "source-semantic-proposal-workset-v3", kind: "query",
        model: "gemini-3.1-flash-lite", request_profile: "gemini-3.1-minimal-v1",
        provider_url: "http://127.0.0.1:9", items: [{ original_query: "which parcel was sent?" }] },
      query_cache_root: join(root, "q-cache"), correspondence_cache_root: join(root, "c-cache"),
      max_output_tokens: 4096, discovery_page_cap: 1, correspondence_pair_cap: 1,
      access_policy: "canonical-v1",
      budget: { schema_version: 1, work_units: 100, memory_bytes: 4096, page_budget: 80,
        finalization_reserve: 20, min_envelope: 10 },
      authorized_scopes: { mode: "unrestricted" }, output_byte_limit: 1024, ...chainExtra
    }
  } };
}

it("imports a freeze chain without snapshot fields and admits omitted full-catalog options", () => {
  const { root, value } = freezeInput();
  declareRecoveryInitialQueryPreparation(value, root);
  expect(existsSync(join(root, "initial-Q-preparation.json"))).toBe(true);
});

it("reuses protocol pairing for scoped demand+cap and rejects unpaired fields or snapshot on chain", () => {
  const paired = freezeInput({
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 2 },
    correspondence_cap: 2
  });
  declareRecoveryInitialQueryPreparation(paired.value, paired.root);
  const unpairedCap = freezeInput({ correspondence_cap: 1 });
  expect(() => declareRecoveryInitialQueryPreparation(unpairedCap.value, unpairedCap.root))
    .toThrow(/must appear together/u);
  const unpairedDemand = freezeInput({
    correspondence_demand: { kind: "query_branches", maximum_demands_per_interpretation: 1 }
  });
  expect(() => declareRecoveryInitialQueryPreparation(unpairedDemand.value, unpairedDemand.root))
    .toThrow(/must appear together/u);
  const withSnapshot = freezeInput({ snapshot_path: "/recovery-unbound", snapshot_sha256: "0".repeat(64) });
  expect(() => declareRecoveryInitialQueryPreparation(withSnapshot.value, withSnapshot.root)).toThrow();
});
