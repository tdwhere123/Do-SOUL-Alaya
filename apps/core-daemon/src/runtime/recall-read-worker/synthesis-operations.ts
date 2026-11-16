import type { RecallReadWorkerRequest } from "./protocol.js";
import type { ParsedWorkerOperation } from "./operation-schemas.js";
import { runSynthesisFieldOperation } from "./field-operations.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type SynthesisOperation = Extract<RecallReadWorkerRequest["operation"], `synthesis.${string}`>;

export async function runSynthesisOperation(
  runtime: RecallReadWorkerRuntime,
  parsed: ParsedWorkerOperation<SynthesisOperation>
) {
  const { synthesisCapsuleRepo } = runtime;
  if (parsed.operation === "synthesis.searchByKeyword") {
    const { payload } = parsed;
    return await synthesisCapsuleRepo.searchByKeyword(
      payload.workspaceId,
      payload.queryText,
      payload.limit
    );
  }
  if (parsed.operation === "synthesis.searchByKeywordField") {
    return await runSynthesisFieldOperation(synthesisCapsuleRepo, parsed.payload);
  }
  if (parsed.operation === "synthesis.searchManyByKeywordField") {
    const { payload } = parsed;
    return await synthesisCapsuleRepo.searchManyByKeywordField(
      payload.workspaceId,
      payload.queries
    );
  }
  const { payload } = parsed;
  return await synthesisCapsuleRepo.findByIds(payload.workspaceId, payload.objectIds);
}
