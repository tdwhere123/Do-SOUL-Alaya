import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  type SourceIndexQueryResources, type SourceIndexResources, type SourceSemanticResourceBudget
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";

export function targetDecodeReservation(bytes: number): SourceSemanticResourceBudget {
  return { work_units: 129 + bytes, memory_bytes: 4096 + 5 * bytes };
}

/** Shared native/decoded accounting for bounded SourceIndex query readers. */
export class QueryReadMeter {
  readonly ledger: SourceSemanticResourceLedger;
  private nativeBytes = 0;
  constructor(budget: SourceSemanticResourceBudget) {
    for (const value of [budget.work_units, budget.memory_bytes]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new StorageError("VALIDATION_FAILED", "invalid source query budget");
    }
    this.ledger = new SourceSemanticResourceLedger(budget);
  }
  read(work: number, bytes: number): void {
    this.ledger.charge(work, bytes, "source index query read"); this.nativeBytes += bytes;
  }
  /** Rows already returned by SQLite remain native reads even when their logical charge is refused. */
  readRows(rowBytes: readonly number[]): SourceSemanticResourceExhausted | null {
    for (let paid = 0; paid < rowBytes.length; paid++) {
      try { this.read(1, rowBytes[paid]!); } catch (error) {
        if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
        for (let unpaid = paid; unpaid < rowBytes.length; unpaid++) {
          this.ledger.charge(Math.min(1, this.ledger.work), Math.min(rowBytes[unpaid]!, this.ledger.bytes), "source index query read");
          this.nativeBytes += rowBytes[unpaid]!;
        }
        return error;
      }
    }
    return null;
  }
  absorb(resources: SourceIndexResources): void { this.read(resources.work, resources.native_bytes); }
  absorbQuery(resources: SourceIndexQueryResources): void {
    this.ledger.charge(resources.work, resources.memory_bytes, "source index bounded query phase");
    this.nativeBytes += resources.native_bytes;
  }
  remaining() { return { work: this.ledger.work, native_bytes: this.ledger.bytes }; }
  resources(): SourceIndexQueryResources {
    return { work: this.ledger.spentWork, native_bytes: this.nativeBytes,
      memory_bytes: this.ledger.spentBytes, sql_internal_work: "unknown" };
  }
}
