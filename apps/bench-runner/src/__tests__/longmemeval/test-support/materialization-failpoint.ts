import * as materializationTransaction from
  "../../../runs/extraction/cache-audit/materialization/transaction.js";
import type { MaterializationDurableFailpoint } from
  "../../../runs/extraction/cache-audit/materialization/transaction.js";

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

export function runMaterializationTransactionForTests(
  input: Omit<
    Parameters<typeof materializationTransaction.runMaterializationTransaction>[0],
    "durableFailpoint"
  >
): ReturnType<typeof materializationTransaction.runMaterializationTransaction> {
  return materializationTransaction.runMaterializationTransaction({
    ...input,
    durableFailpoint: installedMaterializationDurableFailpoint()
  });
}
