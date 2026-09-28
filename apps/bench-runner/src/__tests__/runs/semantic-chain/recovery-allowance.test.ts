import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
