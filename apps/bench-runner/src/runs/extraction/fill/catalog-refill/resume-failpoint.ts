export type CatalogRefillResumeDurableBoundary =
  | "failure-manifest-published"
  | "in-progress-result-manifest-published";

export type CatalogRefillResumeFailpoint =
  (boundary: CatalogRefillResumeDurableBoundary) => void;

let installedFailpoint: CatalogRefillResumeFailpoint | undefined;

export function installCatalogRefillResumeFailpoint(
  failpoint: CatalogRefillResumeFailpoint | undefined
): void {
  installedFailpoint = failpoint;
}

export function triggerCatalogRefillResumeTestSigkillAfter(
  boundary: CatalogRefillResumeDurableBoundary
): void {
  installedFailpoint?.(boundary);
}
