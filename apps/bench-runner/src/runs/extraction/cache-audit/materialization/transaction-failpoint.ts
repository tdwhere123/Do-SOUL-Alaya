export type MaterializationDurableBoundary =
  | "journal-published"
  | "stage-entry-published"
  | "manifest-published"
  | "commit-published-before-journal-unlink"
  | "journal-unlinked";

export type MaterializationDurableFailpoint =
  (boundary: MaterializationDurableBoundary) => void;

let installedFailpoint: MaterializationDurableFailpoint | undefined;

export function installMaterializationDurableFailpoint(
  failpoint: MaterializationDurableFailpoint | undefined
): void {
  installedFailpoint = failpoint;
}

export function triggerMaterializationTestSigkillAfter(
  boundary: MaterializationDurableBoundary
): void {
  installedFailpoint?.(boundary);
}
