import { lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { SourceSemanticWorkerWorkSchema } from "@do-soul/alaya-protocol";
import { chainIdentity } from "./contract.js";
import { boundedArtifactEntryExists, withBoundedStableRegularFile, withRootBoundDirectory }
  from "../extraction/cache-audit/bounded-artifact-reader.js";

const Amount = z.number().int().nonnegative().safe();
export const RecoveryAllowanceSchema = z.object({
  total_work_units: Amount.positive(), total_memory_bytes: Amount.positive(),
  read_work_units: Amount.positive(), read_memory_bytes: Amount.positive(),
  max_input_bytes_per_read: Amount.min(32 * 1024 * 1024),
  max_read_admissions: Amount.min(1).max(1024), max_effects: Amount.min(1).max(64)
}).strict();
export type RecoveryAllowance = z.infer<typeof RecoveryAllowanceSchema>;

type CycleRow = { identity: string; allowance_json: string; snapshot_path: string;
  work_reserved: number; memory_reserved: number; read_count: number; effect_count: number };

/** SQLite serializes the shared finite reservation before any source read or native effect. */
function withCycle<T>(rootInput: string, apply: (db: DatabaseSync, cycle: CycleRow) => T): T {
  const root = resolve(rootInput);
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "recovery-allowance.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("CREATE TABLE IF NOT EXISTS cycle (identity TEXT PRIMARY KEY, allowance_json TEXT NOT NULL, snapshot_path TEXT NOT NULL, work_reserved INTEGER NOT NULL, memory_reserved INTEGER NOT NULL, read_count INTEGER NOT NULL, effect_count INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS effects (name TEXT PRIMARY KEY, identity TEXT NOT NULL, work_units INTEGER NOT NULL, memory_bytes INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS native_observations (name TEXT PRIMARY KEY, work_json TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS read_observations (ordinal INTEGER PRIMARY KEY, label TEXT NOT NULL, input_bytes INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS effect_exclusion (singleton INTEGER PRIMARY KEY CHECK(singleton=1), name TEXT NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    try {
      const cycle = db.prepare("SELECT * FROM cycle LIMIT 1").get() as CycleRow | undefined;
      if (cycle === undefined) throw new AlayaError("CONFLICT", "recovery total allowance was not frozen before work");
      const value = apply(db, cycle);
      db.exec("COMMIT");
      return value;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

export function freezeRecoveryAllowance(rootInput: string, inputIdentity: string,
  allowanceInput: unknown, snapshotPathInput: string): void {
  const allowance = RecoveryAllowanceSchema.parse(allowanceInput);
  const root = resolve(rootInput), snapshotPath = resolve(snapshotPathInput);
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "recovery-allowance.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("CREATE TABLE IF NOT EXISTS cycle (identity TEXT PRIMARY KEY, allowance_json TEXT NOT NULL, snapshot_path TEXT NOT NULL, work_reserved INTEGER NOT NULL, memory_reserved INTEGER NOT NULL, read_count INTEGER NOT NULL, effect_count INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS effects (name TEXT PRIMARY KEY, identity TEXT NOT NULL, work_units INTEGER NOT NULL, memory_bytes INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS native_observations (name TEXT PRIMARY KEY, work_json TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS read_observations (ordinal INTEGER PRIMARY KEY, label TEXT NOT NULL, input_bytes INTEGER NOT NULL)");
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = db.prepare("SELECT * FROM cycle LIMIT 1").get() as CycleRow | undefined;
      if (prior !== undefined) {
        if (prior.identity !== inputIdentity || prior.allowance_json !== canonicalJson(allowance) ||
            prior.snapshot_path !== snapshotPath) throw new AlayaError("CONFLICT", "recovery total allowance changed");
      } else {
        if (allowance.total_work_units < allowance.read_work_units ||
            allowance.total_memory_bytes < allowance.read_memory_bytes) {
          throw new AlayaError("UNAVAILABLE", "recovery bootstrap exceeds its frozen total allowance");
        }
        db.prepare("INSERT INTO cycle VALUES (?, ?, ?, ?, ?, 1, 0)").run(
          inputIdentity, canonicalJson(allowance), snapshotPath,
          allowance.read_work_units, allowance.read_memory_bytes);
        db.prepare("INSERT INTO read_observations VALUES (1, ?, 0)").run("bootstrap bounded config and ledger initialization");
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

/** Every recursive admission takes another finite read reservation, including completed replay. */
export function reserveRecoveryRead(root: string, label: string, additionalPaths: readonly string[] = []): void {
  withCycle(root, (db, cycle) => {
    const allowance = RecoveryAllowanceSchema.parse(JSON.parse(cycle.allowance_json));
    let bytes = 0;
    for (const path of new Set([cycle.snapshot_path, ...additionalPaths].map(path => resolve(path)))) {
      // Callers supply the bounded reader inventory, not a recursive cache/archive scan.
      // Resolve-path duplicates count once; distinct hard-linked names remain distinct inputs.
      if (!boundedArtifactEntryExists(path)) continue;
      if (lstatSync(path).isDirectory()) {
        withRootBoundDirectory({ root: path, label: "recovery input directory" }, () => undefined);
        continue;
      }
      bytes += withRootBoundDirectory({ root: dirname(path), label: "recovery input parent" }, directory =>
        withBoundedStableRegularFile({ path: join(directory, basename(path)),
          maxBytes: allowance.max_input_bytes_per_read, label: "recovery input" }, (_descriptor, opened) => Number(opened.size)));
    }
    if (cycle.read_count >= allowance.max_read_admissions || bytes > allowance.max_input_bytes_per_read) {
      throw new AlayaError("UNAVAILABLE", `recovery read allowance cannot admit ${label}`);
    }
    reserveTotal(cycle, allowance, allowance.read_work_units, allowance.read_memory_bytes);
    db.prepare("UPDATE cycle SET work_reserved=?, memory_reserved=?, read_count=? WHERE identity=?").run(
      cycle.work_reserved + allowance.read_work_units, cycle.memory_reserved + allowance.read_memory_bytes,
      cycle.read_count + 1, cycle.identity);
    db.prepare("INSERT INTO read_observations VALUES (?, ?, ?)").run(cycle.read_count + 1, label, bytes);
  });
}

/** A named action spends once. The existing stage reservation owns no-retry and completion checks. */
export function reserveRecoveryAction(root: string, name: string, identity: string,
  workUnits: number, memoryBytes: number, completed: boolean, exclusiveRoot = false): void {
  withCycle(root, (db, cycle) => {
    const allowance = RecoveryAllowanceSchema.parse(JSON.parse(cycle.allowance_json));
    const prior = db.prepare("SELECT identity, work_units, memory_bytes FROM effects WHERE name=?").get(name) as
      { identity: string; work_units: number; memory_bytes: number } | undefined;
    if (prior !== undefined) {
      if (prior.identity !== identity || prior.work_units !== workUnits || prior.memory_bytes !== memoryBytes) {
        throw new AlayaError("CONFLICT", "recovery action reservation changed");
      }
      if (!completed) throw new AlayaError("CONFLICT", "reserved recovery effect has no durable result; another execution is forbidden");
      return;
    }
    if (completed) throw new AlayaError("CONFLICT", "durable recovery result lacks its prior numeric reservation");
    const excluded = db.prepare("SELECT name FROM effect_exclusion WHERE singleton=1").get();
    if (excluded !== undefined || exclusiveRoot && db.prepare("SELECT name FROM effects LIMIT 1").get() !== undefined) {
      throw new AlayaError("CONFLICT", "source experiment root already has an effect reservation");
    }
    if (cycle.effect_count >= allowance.max_effects) throw new AlayaError("UNAVAILABLE", "recovery effect allowance exhausted");
    reserveTotal(cycle, allowance, workUnits, memoryBytes);
    db.prepare("INSERT INTO effects VALUES (?, ?, ?, ?)").run(name, identity, workUnits, memoryBytes);
    if (exclusiveRoot) db.prepare("INSERT INTO effect_exclusion VALUES (1, ?)").run(name);
    db.prepare("UPDATE cycle SET work_reserved=?, memory_reserved=?, effect_count=? WHERE identity=?").run(
      cycle.work_reserved + workUnits, cycle.memory_reserved + memoryBytes, cycle.effect_count + 1, cycle.identity);
  });
}

export function reserveRecoveryHostEffect(root: string, name: string, identity: string, completed: boolean, exclusiveRoot = false): void {
  const allowance = withCycle(root, (_db, cycle) => RecoveryAllowanceSchema.parse(JSON.parse(cycle.allowance_json)));
  reserveRecoveryAction(root, name, identity, allowance.read_work_units, allowance.read_memory_bytes, completed, exclusiveRoot);
}

function reserveTotal(cycle: CycleRow, allowance: RecoveryAllowance, work: number, memory: number): void {
  if (!Number.isSafeInteger(work) || !Number.isSafeInteger(memory) || work < 0 || memory < 0 ||
      cycle.work_reserved + work > allowance.total_work_units ||
      cycle.memory_reserved + memory > allowance.total_memory_bytes) {
    throw new AlayaError("UNAVAILABLE", "recovery total allowance exhausted before action");
  }
}

export function recoveryAllowanceIdentity(root: string): string {
  let db: DatabaseSync;
  try { db = new DatabaseSync(join(resolve(root), "recovery-allowance.sqlite"), { readOnly: true }); }
  catch (cause) { throw new AlayaError("CONFLICT", "recovery total allowance owner is unavailable", { cause }); }
  try {
    const rows = db.prepare("SELECT identity, allowance_json, snapshot_path FROM cycle LIMIT 2").all() as
      Pick<CycleRow, "identity" | "allowance_json" | "snapshot_path">[];
    if (rows.length !== 1 || typeof rows[0]?.identity !== "string" ||
        typeof rows[0].allowance_json !== "string" || typeof rows[0].snapshot_path !== "string") {
      throw new AlayaError("CONFLICT", "recovery total allowance was not frozen before work");
    }
    const allowance = RecoveryAllowanceSchema.parse(JSON.parse(rows[0].allowance_json));
    return chainIdentity({ cycle: rows[0].identity,
      allowance, snapshot_path: rows[0].snapshot_path });
  } catch (cause) {
    if (cause instanceof AlayaError) throw cause;
    throw new AlayaError("CONFLICT", "recovery total allowance owner is malformed", { cause });
  } finally { db.close(); }
}

/** Readback only: absence is not a new reservation or permission to execute. */
export function readRecoveryAction(root: string, name: string) {
  const path = join(resolve(root), "recovery-allowance.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT identity, work_units, memory_bytes FROM effects WHERE name=?").get(name) as
      { identity: string; work_units: number; memory_bytes: number } | undefined;
    return row;
  } finally { db.close(); }
}

/** Actual worker meters are retained independently of the no-refund reservation. */
export function recordRecoveryNativeWork(root: string, name: string, workInput: unknown): void {
  const work = SourceSemanticWorkerWorkSchema.parse(workInput);
  withCycle(root, (db, _cycle) => {
    const effect = db.prepare("SELECT work_units, memory_bytes FROM effects WHERE name=?").get(name) as
      { work_units: number; memory_bytes: number } | undefined;
    if (effect === undefined || (work.logical_work ?? work.native_work) > effect.work_units ||
        work.logical_memory_bytes > effect.memory_bytes) {
      throw new AlayaError("CONFLICT", "native work exceeds its prior cycle reservation");
    }
    const prior = db.prepare("SELECT work_json FROM native_observations WHERE name=?").get(name) as
      { work_json: string } | undefined;
    if (prior !== undefined) {
      if (prior.work_json !== canonicalJson(work)) throw new AlayaError("CONFLICT", "native work meter changed on replay");
      return;
    }
    db.prepare("INSERT INTO native_observations VALUES (?, ?)").run(name, canonicalJson(work));
  });
}
