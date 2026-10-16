import {
  SOURCE_SEMANTIC_PUBLISHED_CONTRACT, SourceSemanticPublishedInterpretationSchema, type SourceSemanticCoverage
} from "@do-soul/alaya-protocol";
import { CoreError, fieldContractSha256, semanticInterpretationEvidenceId,
  verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { SqliteSourceHintReader } from "@do-soul/alaya-storage";
import type { SourceSemanticReadRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { sourceSemanticReadStores, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";

export type SourceSemanticWorkerPayload = WorkerOperationPayload<"conditionalField.sourceSemantics">;
export const IDLE: SourceSemanticCoverage = {
  discovery: "unexercised", source_interpretation: "unexercised", query_semantics: "unexercised",
  semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete"
};

type VerifiedInterpretation = NonNullable<ReturnType<typeof verifyPublishedSourceSemanticInterpretation>>;
export function loadVerified(runtime: SourceSemanticReadRuntime, workspace: string, identity: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget): VerifiedInterpretation;
export function loadVerified(runtime: SourceSemanticReadRuntime, workspace: string, identity: Readonly<{ evidence_object_id: string }>,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  beforeSourceRead?: (bound: ReturnType<typeof SourceSemanticPublishedInterpretationSchema.parse>) => boolean): VerifiedInterpretation | null;
export function loadVerified(runtime: SourceSemanticReadRuntime, workspace: string, identity: string | Readonly<{ evidence_object_id: string }>,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget,
  beforeSourceRead?: (bound: ReturnType<typeof SourceSemanticPublishedInterpretationSchema.parse>) => boolean): VerifiedInterpretation | null {
  const expected = typeof identity === "string" ? identity : undefined;
  let objectId = typeof identity === "string" ? semanticInterpretationEvidenceId(identity, fieldContractSha256, workspace) : identity.evidence_object_id;
  meter.reserve(3, 48);
  const reader = new SqliteSourceHintReader(runtime.database.connection);
  const capsule = expected === undefined ? reader.readBoundInterpretation(workspace, objectId, meter.bytes)
    : reader.readBoundInterpretationCompatible(workspace,
      [objectId, semanticInterpretationEvidenceId(expected, fieldContractSha256)], meter.bytes);
  if ("objectId" in capsule && typeof capsule.objectId === "string") objectId = capsule.objectId;
  meter.read(capsule.nativeVisits, capsule.bytesRead);
  if (capsule.status !== "complete" || capsule.gist === null) {
    throw new CoreError("CONFLICT", `source semantic interpretation read is ${capsule.status}`, { details: { admission: "unavailable", unavailable: capsule.status } });
  }
  meter.charge(capsule.gist.length + 1, capsule.bytesRead * 4, "interpretation decoding");
  let raw: unknown;
  try { raw = JSON.parse(capsule.gist); } catch {
    throw new CoreError("VALIDATION", "stored interpretation is malformed", { details: { admission: "invalid" } });
  }
  if (expected === undefined && (typeof raw !== "object" || raw === null || !("contract" in raw)
      || raw.contract !== SOURCE_SEMANTIC_PUBLISHED_CONTRACT)) return null;
  const parsed = SourceSemanticPublishedInterpretationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CoreError("VALIDATION", "stored interpretation is malformed",
      { details: { admission: "invalid", reason: "malformed_interpretation" } });
  }
  const bound = parsed.data;
  const ids = [semanticInterpretationEvidenceId(bound.interpretation_id, fieldContractSha256, workspace),
    semanticInterpretationEvidenceId(bound.interpretation_id, fieldContractSha256)];
  if (expected !== undefined && bound.interpretation_id !== expected || !ids.includes(objectId) ||
      bound.source_target.workspace_id !== workspace) {
    throw new CoreError("VALIDATION", "interpretation identity mismatch");
  }
  if (expected === undefined) {
    meter.reserve(3, 48);
    const compatible = reader.readBoundInterpretationCompatible(workspace, ids, meter.bytes, true);
    meter.read(compatible.nativeVisits, compatible.bytesRead);
    if (compatible.status !== "complete" || compatible.objectId !== objectId) {
      throw new CoreError("CONFLICT", `source semantic interpretation read is ${compatible.status}`,
        { details: { admission: "unavailable", unavailable: compatible.status } });
    }
  }
  const stores = sourceSemanticReadStores(runtime.database, workspace, bound.interpretation.source.source_id, meter, authorized);
  meter.retain(bound, "interpretation verification");
  return verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256, meter }, bound, workspace, beforeSourceRead);
}

export function workOf(meter: SourceSemanticReadBudget) {
  return { native_work: meter.nativeWork, index_work: meter.indexWork,
    native_accounting: meter.indexWork > 0 ? "partial" as const : "complete" as const,
    logical_work: meter.spentWork, native_bytes: meter.nativeBytes,
    logical_memory_bytes: meter.spentBytes, rss_bytes: process.memoryUsage().rss };
}
export function admissionOf(error: CoreError): string | undefined {
  const value = error.details?.admission;
  return typeof value === "string" ? value : undefined;
}
