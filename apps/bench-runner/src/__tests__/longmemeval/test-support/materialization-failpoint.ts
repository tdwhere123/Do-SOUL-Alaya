import type {
  MaterializationDurableFailpoint
} from "../../../runs/extraction/cache-audit/materialization/transaction.js";

let installedFailpoint: MaterializationDurableFailpoint | undefined;

export function installMaterializationDurableFailpoint(
  failpoint: MaterializationDurableFailpoint | undefined
): void {
  installedFailpoint = failpoint;
}

export function installedMaterializationDurableFailpoint():
  MaterializationDurableFailpoint | undefined {
  return installedFailpoint;
}
