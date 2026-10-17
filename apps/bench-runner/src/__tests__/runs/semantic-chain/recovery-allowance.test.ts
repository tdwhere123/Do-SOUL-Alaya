import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { freezeRecoveryAllowance, recoveryAllowanceIdentity, reserveRecoveryAction, reserveRecoveryRead } from
  "../../../runs/semantic-chain/recovery-allowance.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("spends the finite bootstrap and read slots before allowing one distinct effect claim", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-allowance-")); roots.push(root);
  const snapshot = join(root, "sealed.sqlite");
  writeFileSync(snapshot, "sealed");
  const allowance = { total_work_units: 30, total_memory_bytes: 30,
    read_work_units: 10, read_memory_bytes: 10, max_input_bytes_per_read: 32 * 1024 * 1024,
    max_read_admissions: 2, max_effects: 1 };
  freezeRecoveryAllowance(root, "frozen-input", allowance, snapshot);
  reserveRecoveryRead(root, "first bounded reopen");
  expect(() => reserveRecoveryRead(root, "third bounded reopen")).toThrow("read allowance");
  reserveRecoveryAction(root, "native-prepare", "same-input", 10, 10, false);
  expect(() => reserveRecoveryAction(root, "native-prepare", "same-input", 10, 10, false))
    .toThrow("no durable result");
  expect(() => reserveRecoveryAction(root, "native-recall", "same-input", 10, 10, false))
    .toThrow("effect allowance exhausted");
  expect(() => freezeRecoveryAllowance(root, "changed-input", allowance, snapshot)).toThrow("changed");
});

it("prices distinct nested inventory files once, not directory inodes, and refuses aggregate input overflow", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-input-bytes-")); roots.push(root);
  const snapshot = join(root, "snapshot"), nested = join(root, "cache", "ab"), a = join(nested, "a.json"), b = join(nested, "b.json");
  mkdirSync(nested, { recursive: true }); writeFileSync(snapshot, "sealed"); writeFileSync(a, "123"); writeFileSync(b, "4567");
  freezeRecoveryAllowance(root, "input-inventory", { total_work_units: 100, total_memory_bytes: 100,
    read_work_units: 1, read_memory_bytes: 1, max_input_bytes_per_read: 32 * 1024 * 1024,
    max_read_admissions: 8, max_effects: 1 }, snapshot);
  reserveRecoveryRead(root, "contained nested input", [nested, a, b, a, snapshot, join(nested, "absent")]);
  const db = new DatabaseSync(join(root, "recovery-allowance.sqlite"), { readOnly: true });
  try { expect(db.prepare("SELECT input_bytes FROM read_observations WHERE ordinal=2").get()!.input_bytes).toBe(13); }
  finally { db.close(); }
  truncateSync(a, 20 * 1024 * 1024); truncateSync(b, 20 * 1024 * 1024);
  expect(() => reserveRecoveryRead(root, "oversized nested inputs", [nested, a, b])).toThrow("read allowance cannot admit");
});

it("rejects leaf and directory symlink inventory escapes without following them", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-contained-input-")); roots.push(root);
  const snapshot = join(root, "snapshot"), foreign = join(root, "foreign"), cache = join(root, "cache");
  writeFileSync(snapshot, "sealed"); mkdirSync(foreign); mkdirSync(cache); writeFileSync(join(foreign, "body"), "foreign");
  symlinkSync(join(foreign, "body"), join(cache, "leaf")); symlinkSync(foreign, join(cache, "directory"), "dir");
  freezeRecoveryAllowance(root, "contained-inputs", { total_work_units: 100, total_memory_bytes: 100,
    read_work_units: 1, read_memory_bytes: 1, max_input_bytes_per_read: 32 * 1024 * 1024,
    max_read_admissions: 8, max_effects: 1 }, snapshot);
  expect(() => reserveRecoveryRead(root, "leaf escape", [join(cache, "leaf")])).toThrow();
  expect(() => reserveRecoveryRead(root, "directory escape", [join(cache, "directory", "body")])).toThrow();
  expect(() => reserveRecoveryRead(root, "directory itself", [join(cache, "directory")])).toThrow();
});

it("reads a frozen allowance identity without creating or repairing its owner", () => {
  const root = mkdtempSync(join(tmpdir(), "recovery-allowance-owner-")); roots.push(root);
  const missing = join(root, "missing"), missingDb = join(missing, "recovery-allowance.sqlite");
  expect(() => recoveryAllowanceIdentity(missing)).toThrow("unavailable");
  expect(existsSync(missing)).toBe(false);
  expect(existsSync(missingDb)).toBe(false);

  const malformed = join(root, "malformed");
  const malformedDb = join(malformed, "recovery-allowance.sqlite");
  mkdirSync(malformed);
  writeFileSync(malformedDb, "not sqlite");
  expect(() => recoveryAllowanceIdentity(malformed)).toThrow("malformed");
  expect(readFileSync(malformedDb, "utf8")).toBe("not sqlite");

  const uninitialized = join(root, "uninitialized");
  mkdirSync(uninitialized);
  const uninitializedDb = join(uninitialized, "recovery-allowance.sqlite");
  new DatabaseSync(uninitializedDb).close();
  const size = statSync(uninitializedDb).size;
  expect(() => recoveryAllowanceIdentity(uninitialized)).toThrow("malformed");
  expect(statSync(uninitializedDb).size).toBe(size);
  const db = new DatabaseSync(uninitializedDb, { readOnly: true });
  try { expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]); }
  finally { db.close(); }

  const snapshot = join(root, "sealed.sqlite");
  writeFileSync(snapshot, "sealed");
  const allowance = { total_work_units: 30, total_memory_bytes: 30,
    read_work_units: 10, read_memory_bytes: 10, max_input_bytes_per_read: 32 * 1024 * 1024,
    max_read_admissions: 2, max_effects: 1 };
  freezeRecoveryAllowance(root, "frozen-input", allowance, snapshot);
  const identity = recoveryAllowanceIdentity(root);
  reserveRecoveryRead(root, "bounded reopen");
  expect(recoveryAllowanceIdentity(root)).toBe(identity);
});
