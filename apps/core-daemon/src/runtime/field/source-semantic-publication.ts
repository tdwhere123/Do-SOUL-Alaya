import { SourceSemanticResourceExhausted, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { CoreError, createSourceSemanticInterpretationPublication, fieldContractSha256,
  authorizedScopesFromAdmission, type EvidenceService } from "@do-soul/alaya-core";
import { SqliteSourceHintReader, type StorageDatabase } from "@do-soul/alaya-storage";
import type { SourceSemanticPublicationPort } from "../../mcp-memory/tool/interpretation-handler.js";
import { sourceSemanticReadStores, SourceSemanticReadBudget } from "./source-semantic-read-stores.js";

/** Publication and invalidation share request-bounded reads of the current effective source binding. */
export function createSourceSemanticPublication(input: Readonly<{
  database: StorageDatabase; evidenceService: EvidenceService;
}>): SourceSemanticPublicationPort {
  return {
    publish: request => withPublicationBudget(request.budget ?? { work_units: 200000, memory_bytes: 20000000 }, async meter => {
      const stores = sourceSemanticReadStores(input.database, request.workspaceId, request.artifactKey, meter, null);
      return createSourceSemanticInterpretationPublication({ stores, evidenceService: input.evidenceService,
        sha256: fieldContractSha256 }).publish({ ...request, meter });
    }),
    invalidate: ({ request, budget }) => withPublicationBudget(budget, async meter => {
      const { authorized_scopes } = authorizedScopesFromAdmission(request.authorized_scopes);
      if (authorized_scopes === undefined) throw new CoreError("VALIDATION", "source invalidation requires admitted scopes");
      const stores = sourceSemanticReadStores(input.database, request.workspace_id, request.source.source_id, meter, authorized_scopes);
      const reader = new SqliteSourceHintReader(input.database.connection);
      const invalidation = await input.evidenceService.invalidateSourceInterpretation(request, {
        stores, meter,
        readCapsule: (workspaceId, ids) => {
          meter.reserve(3, 48, "invalidation capsule read");
          const capsule = reader.readBoundInterpretationForLifecycle(workspaceId, ids, meter.bytes);
          meter.read(capsule.nativeVisits, capsule.bytesRead, "invalidation capsule read");
          if (capsule.status === "absent") return null;
          if (capsule.status === "resource_limited") throw new SourceSemanticResourceExhausted("invalidation capsule read");
          if (capsule.status !== "complete" || !("lifecycleState" in capsule) || capsule.gist === null ||
            capsule.lifecycleState === null || capsule.sourceHash === null) {
            throw new CoreError("CONFLICT", `source interpretation lifecycle read is ${capsule.status}`);
          }
          return { objectId: capsule.objectId, gist: capsule.gist, lifecycleState: capsule.lifecycleState, sourceHash: capsule.sourceHash };
        }
      });
      return { invalidation };
    })
  };
}

async function withPublicationBudget<T extends object>(budget: SourceSemanticResourceBudget,
  execute: (meter: SourceSemanticReadBudget) => Promise<T>) {
  const meter = new SourceSemanticReadBudget(budget);
  try {
    const result = await execute(meter);
    return { ...result, resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes,
      native_work: meter.nativeWork, native_bytes: meter.nativeBytes } };
  } catch (error) {
    const work = { native_work: meter.nativeWork, native_bytes: meter.nativeBytes,
      logical_work: meter.spentWork, logical_memory_bytes: meter.spentBytes, rss_bytes: process.memoryUsage().rss };
    if (error instanceof SourceSemanticResourceExhausted) throw new CoreError("CONFLICT", error.message, {
      subCode: "RETRYABLE_BACKPRESSURE", details: { work }
    });
    if (error instanceof CoreError) throw new CoreError(error.code, error.message, {
      subCode: error.subCode, details: { ...error.details, work }
    });
    throw error;
  }
}
