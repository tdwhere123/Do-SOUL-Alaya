import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { freezeRecoveryAllowance, reserveRecoveryAction, reserveRecoveryRead } from
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
