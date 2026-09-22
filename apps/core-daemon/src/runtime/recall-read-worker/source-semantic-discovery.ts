import {
  SourceSemanticPublishedInterpretationSchema, type SourceSemanticCoverage
} from "@do-soul/alaya-protocol";
import { CoreError, fieldContractSha256, semanticInterpretationEvidenceId,
  verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { SqliteSourceHintReader } from "@do-soul/alaya-storage";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { sourceSemanticReadStores, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";

export type SourceSemanticWorkerPayload = WorkerOperationPayload<"conditionalField.sourceSemantics">;
export const IDLE: SourceSemanticCoverage = {
  discovery: "unexercised", source_interpretation: "unexercised", query_semantics: "unexercised",
  semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete"
};

export function loadVerified(runtime: RecallReadWorkerRuntime, workspace: string, interpretationId: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget) {
  meter.reserve(1, 16);
  const capsule = new SqliteSourceHintReader(runtime.database.connection).readBoundInterpretation(
    workspace, semanticInterpretationEvidenceId(interpretationId, fieldContractSha256), meter.bytes);
  meter.read(capsule.nativeVisits, capsule.bytesRead);
  if (capsule.status !== "complete" || capsule.gist === null) {
    throw new CoreError("CONFLICT", `source semantic interpretation read is ${capsule.status}`, { details: { admission: "unavailable", unavailable: capsule.status } });
  }
  meter.charge(capsule.gist.length + 1, capsule.bytesRead * 4, "interpretation decoding");
  let raw: unknown;
  try { raw = JSON.parse(capsule.gist); } catch {
    throw new CoreError("VALIDATION", "stored interpretation is malformed", { details: { admission: "invalid" } });
  }
  const parsed = SourceSemanticPublishedInterpretationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CoreError("VALIDATION", "stored interpretation is malformed",
      { details: { admission: "invalid", reason: "malformed_interpretation" } });
  }
  const bound = parsed.data;
  if (bound.interpretation_id !== interpretationId) throw new CoreError("VALIDATION", "interpretation identity mismatch");
  const stores = sourceSemanticReadStores(runtime.database, workspace, bound.interpretation.source.source_id, meter, authorized);
  meter.retain(bound, "interpretation verification");
  return verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256, meter }, bound, workspace);
}

export function workOf(meter: SourceSemanticReadBudget) {
  return { native_work: meter.nativeWork, logical_work: meter.spentWork, native_bytes: meter.nativeBytes,
    logical_memory_bytes: meter.spentBytes, rss_bytes: process.memoryUsage().rss };
}
export function admissionOf(error: CoreError): string | undefined {
  const value = error.details?.admission;
  return typeof value === "string" ? value : undefined;
}
