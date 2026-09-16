import * as extractionFill from "../../../runs/extraction/extraction-fill.js";
import {
  CATALOG_REFILL_TEST_FAILPOINT_ENV,
  type ExtractionFillOptions,
  type ExtractionFillResult
} from "../../../runs/extraction/extraction-fill.js";
import type { CatalogRefillResumeFailpoint } from
  "../../../runs/extraction/fill/catalog-refill/runtime.js";

let installedFailpoint: CatalogRefillResumeFailpoint | undefined;

export function installCatalogRefillResumeFailpoint(
  failpoint: CatalogRefillResumeFailpoint | undefined
): void {
  installedFailpoint = failpoint;
}

export function installedCatalogRefillResumeFailpoint():
  CatalogRefillResumeFailpoint | undefined {
  return installedFailpoint;
}

function killSelf(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("durable failpoint SIGKILL was not delivered");
}

const catalogBoundary = process.env[CATALOG_REFILL_TEST_FAILPOINT_ENV];
if (catalogBoundary !== undefined) {
  installCatalogRefillResumeFailpoint((boundary) => {
    if (boundary === catalogBoundary) killSelf();
  });
}

export function runExtractionFillForTests(
  options: ExtractionFillOptions
): Promise<ExtractionFillResult> {
  return extractionFill.runExtractionFillWithDurableFailpoint(
    options, installedCatalogRefillResumeFailpoint()
  );
}
