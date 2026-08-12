export type CatalogRefillResumeDurableBoundary =
  | "failure-manifest-published"
  | "in-progress-result-manifest-published";

export function triggerCatalogRefillResumeTestSigkillAfter(
  boundary: CatalogRefillResumeDurableBoundary
): void {
  if (process.env.NODE_ENV !== "test" ||
      process.env.ALAYA_TEST_CATALOG_REFILL_SIGKILL_AFTER !== boundary) return;
  process.kill(process.pid, "SIGKILL");
}
