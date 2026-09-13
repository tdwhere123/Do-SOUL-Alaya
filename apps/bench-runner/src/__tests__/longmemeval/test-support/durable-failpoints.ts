import { installMaterializationDurableFailpoint } from
  "../../../runs/extraction/cache-audit/materialization/transaction-failpoint.js";
import { installCatalogRefillResumeFailpoint } from
  "../../../runs/extraction/fill/catalog-refill/resume-failpoint.js";

function killSelf(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("durable failpoint SIGKILL was not delivered");
}

const materializationBoundary = process.env.ALAYA_TEST_MATERIALIZATION_SIGKILL_AFTER;
if (materializationBoundary !== undefined) {
  installMaterializationDurableFailpoint((boundary) => {
    if (boundary === materializationBoundary) killSelf();
  });
}

const catalogBoundary = process.env.ALAYA_TEST_CATALOG_REFILL_SIGKILL_AFTER;
if (catalogBoundary !== undefined) {
  installCatalogRefillResumeFailpoint((boundary) => {
    if (boundary === catalogBoundary) killSelf();
  });
}
