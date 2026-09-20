import {
  SOURCE_SEMANTIC_PUBLISHED_CONTRACT, SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_LIBRARY_H_PAGE,
  SourceSemanticHandleDescriptorSchema, SourceSemanticPublishedInterpretationSchema, SourceSemanticResourceExhausted,
  type SourceSemanticCoverage, type SourceSemanticHandleDescriptor
} from "@do-soul/alaya-protocol";
import { CoreError, fieldContractSha256, semanticInterpretationEvidenceId,
  verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { SqliteSourceHintReader } from "@do-soul/alaya-storage";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { sourceSemanticReadStores, SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";

export type SourceSemanticWorkerPayload = WorkerOperationPayload<"conditionalField.sourceSemantics">;
export const IDLE: SourceSemanticCoverage = {
  discovery: "unexercised", h: "unexercised", q: "unexercised", a: "unexercised",
  computation: "unexercised", payload: "complete"
};

/** prepare_query verifies bodies it returns. Library recall pages handle identity only. */
export function discover(runtime: RecallReadWorkerRuntime, payload: SourceSemanticWorkerPayload,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget, after: string | null, sourceId?: string,
  verify = true) {
  const page = new SqliteSourceHintReader(runtime.database.connection).pageBoundInterpretations({
    workspaceId: payload.workspace_id, limit: SOURCE_SEMANTIC_LIBRARY_H_PAGE, nativeLimit: Math.min(32, meter.work), afterCursor: after,
    nativeByteLimit: Math.min(meter.bytes, 1_000_000), maxGistBytes: 1_000_000, activeOnly: true,
    matches: (gist) => { try {
      const contract = JSON.parse(gist)?.contract;
      return contract === SOURCE_SEMANTIC_PUBLISHED_CONTRACT || contract === "published-source-interpretation-v3";
    } catch { return false; } }
  });
  try {
    meter.read(page.nativeVisits, page.bytesRead);
  } catch (error) {
    if (verify || !(error instanceof SourceSemanticResourceExhausted)) throw error;
    return { candidates: [] as SourceSemanticHandleDescriptor[], open: true, cursor: after, truncated: true };
  }
  const candidates: SourceSemanticHandleDescriptor[] = [];
  let open = page.unavailable || page.resourceLimited === true, cursor = after, outputBytes = 0, stopped = false;
  for (const row of page.rows) {
    const identity = publishedHandleIdentity(row.gist);
    if (identity === null) { open = true; cursor = row.cursor; continue; }
    if (sourceId !== undefined && identity.descriptor.source_id !== sourceId) { cursor = row.cursor; continue; }
    if (identity.k_version !== SOURCE_SEMANTIC_K_VERSION) { open = true; cursor = row.cursor; continue; }
    try {
      const candidate = verify
        ? verifiedHandle(runtime, payload.workspace_id, identity.descriptor.interpretation_id, authorized, meter)
        : identity.descriptor;
      if (candidate.interpretation !== undefined && candidate.interpretation.k_version !== SOURCE_SEMANTIC_K_VERSION) {
        open = true; cursor = row.cursor; continue;
      }
      const size = Buffer.byteLength(JSON.stringify(candidate));
      if (outputBytes + size > 800_000) { stopped = true; break; }
      meter.retain(candidate, "descriptor delivery"); candidates.push(candidate); outputBytes += size; cursor = row.cursor;
    } catch (error) {
      if (!verify && error instanceof SourceSemanticResourceExhausted) { stopped = true; open = true; break; }
      if (!(error instanceof CoreError)) throw error;
      const admission = admissionOf(error);
      if (admission !== "filtered" && admission !== "no_eligible_source" && error.code !== "NOT_FOUND") open = true;
      cursor = row.cursor;
    }
  }
  if (!stopped) cursor = page.committedThrough;
  return { candidates, open, cursor, truncated: stopped || page.truncated };
}

function verifiedHandle(runtime: RecallReadWorkerRuntime, workspace: string, hId: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget): SourceSemanticHandleDescriptor {
  const checked = loadVerified(runtime, workspace, hId, authorized, meter);
  const h = checked.bound.interpretation;
  return {
    interpretation_id: checked.bound.interpretation_id, source_id: h.source.source_id, source_version: h.source.source_version,
    content_digest: h.source.content_digest, producer_id: h.producer_id, producer_version: h.producer_version,
    contract_version: h.contract_version, interpretation: h
  };
}

function publishedHandleIdentity(gist: string): { descriptor: SourceSemanticHandleDescriptor; k_version: string } | null {
  try {
    const raw = JSON.parse(gist) as Record<string, unknown> | null;
    const body = raw?.interpretation as Record<string, unknown> | undefined;
    const source = body?.source as Record<string, unknown> | undefined;
    if (raw === null || raw.contract !== SOURCE_SEMANTIC_PUBLISHED_CONTRACT || body === undefined || source === undefined) return null;
    if (typeof raw.interpretation_id !== "string" || typeof source.source_id !== "string"
      || typeof source.source_version !== "string" || typeof source.content_digest !== "string"
      || typeof body.producer_id !== "string" || typeof body.producer_version !== "string"
      || typeof body.contract_version !== "string" || typeof body.k_version !== "string") return null;
    const parsed = SourceSemanticHandleDescriptorSchema.safeParse({
      interpretation_id: raw.interpretation_id, source_id: source.source_id, source_version: source.source_version,
      content_digest: source.content_digest, producer_id: body.producer_id, producer_version: body.producer_version,
      contract_version: body.contract_version
    });
    if (!parsed.success) return null;
    return { descriptor: parsed.data, k_version: body.k_version };
  } catch { return null; }
}

export function loadVerified(runtime: RecallReadWorkerRuntime, workspace: string, hId: string,
  authorized: readonly string[] | null, meter: SourceSemanticReadBudget) {
  meter.reserve(1, 16);
  const capsule = new SqliteSourceHintReader(runtime.database.connection).readBoundInterpretation(
    workspace, semanticInterpretationEvidenceId(hId, fieldContractSha256), meter.bytes);
  meter.read(capsule.nativeVisits, capsule.bytesRead);
  if (capsule.status !== "complete" || capsule.gist === null) {
    throw new CoreError("CONFLICT", `source semantic interpretation read is ${capsule.status}`, { details: { admission: "unavailable", unavailable: capsule.status } });
  }
  meter.charge(1, capsule.bytesRead * 4, "interpretation decoding");
  let raw: unknown;
  try { raw = JSON.parse(capsule.gist); } catch {
    throw new CoreError("VALIDATION", "stored interpretation is malformed", { details: { admission: "invalid" } });
  }
  const parsed = SourceSemanticPublishedInterpretationSchema.safeParse(raw);
  if (!parsed.success) {
    const contract = typeof raw === "object" && raw !== null && "contract" in raw ? raw.contract : undefined;
    throw new CoreError("VALIDATION", contract === "published-source-interpretation-v3"
      ? "stored interpretation requires explicit preparation under the current structural contract" : "stored interpretation is malformed",
    { details: { admission: "invalid", reason: contract === "published-source-interpretation-v3" ? "unsupported_structural_contract" : "malformed_interpretation" } });
  }
  const bound = parsed.data;
  if (bound.interpretation_id !== hId) throw new CoreError("VALIDATION", "interpretation identity mismatch");
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
