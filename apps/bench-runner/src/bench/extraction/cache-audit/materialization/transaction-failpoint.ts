export type MaterializationDurableBoundary =
  | "journal-published"
  | "stage-entry-published"
  | "manifest-published"
  | "commit-published-before-journal-unlink"
  | "journal-unlinked";

export function triggerMaterializationTestSigkillAfter(
  boundary: MaterializationDurableBoundary
): void {
  if (process.env.NODE_ENV !== "test" ||
      process.env.ALAYA_TEST_MATERIALIZATION_SIGKILL_AFTER !== boundary) return;
  process.kill(process.pid, "SIGKILL");
}
