import { join, resolve } from "node:path";
import { AlayaError, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, withSemanticChainDaemon,
  writeChainArtifact } from "./contract.js";
import { admitInitialQualified } from "./recovery-publication.js";
import { reserveRecoveryEffect } from "./recovery-window.js";
import { admitRecoveryQueryReview } from "./recovery-query-review.js";
import { admitRecoveryNomination } from "./recovery-reason.js";
import { reserveRecoveryRead, reserveRecoveryAction, reserveRecoveryHostEffect,
  recordRecoveryNativeWork } from "./recovery-allowance.js";

/** A current keyed Core attention may nominate only its own frozen source tuple. */
export async function prepareRecoverySource(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "prepare selected source input");
  const { window, settled } = admitInitialQualified(root);
  const queryReview = admitRecoveryQueryReview(root).result;
  if (queryReview.qualified_snapshot_identity !== settled.publication_identity) {
    throw new AlayaError("CONFLICT", "fresh source read requires the original-only Q review checkpoint");
  }
  const chosen = admitRecoveryNomination(root);
  const source = window.window.find(row => row.source_id === chosen.source_id &&
    row.source_version === chosen.source_version && row.record_id === chosen.record_id &&
    row.content_digest === chosen.content_digest);
  if (source === undefined || chosen.qualified_snapshot_identity !== settled.publication_identity) {
    throw new AlayaError("CONFLICT", "source nomination no longer names a qualified frozen tuple");
  }
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  const path = join(root, "recovery-source-read.json");
  const identity = chainIdentity({ nomination: chainIdentity(chosen), query_review: chainIdentity(queryReview),
    qualified: settled.publication_identity });
  const prior = readChainArtifact(path);
  reserveRecoveryAction(root, "native-source-read", identity,
    plan.config.budget.work_units, plan.config.budget.memory_bytes, prior !== undefined);
  reserveRecoveryEffect(`${path}.reserved`, identity, prior !== undefined);
  if (prior !== undefined) return prior;
  reserveRecoveryHostEffect(root, "source-read-daemon", identity, false);
  const config = { ...plan.config, snapshot_path: settled.snapshot_path, snapshot_sha256: settled.snapshot_sha256 };
  let response: unknown;
  await withSemanticChainDaemon(config, root, async daemon => {
    response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
      SoulInterpretationRequestSchema.parse({ operation: "prepare_source", source_id: source.source_id,
        budget: config.budget, authorized_scopes: config.authorized_scopes })));
  });
  if (response === undefined || response === null || typeof response !== "object" || !("operation" in response) ||
      response.operation !== "prepare_source") throw new AlayaError("CONFLICT", "native source read returned the wrong operation");
  const prepared = response as Extract<ReturnType<typeof SoulInterpretationResponseSchema.parse>, { operation: "prepare_source" }>;
  if (prepared.source_id !== source.source_id || prepared.source_version !== source.source_version ||
      prepared.content_digest !== source.content_digest || prepared.catalog === undefined) {
    throw new AlayaError("CONFLICT", "fresh source read changed the frozen source tuple");
  }
  recordRecoveryNativeWork(root, "native-source-read", prepared.work);
  const result = { contract: "source-semantic-recovery-source-read-v1", identity,
    reason_identity: chosen.reason_identity, nomination_identity: chainIdentity(chosen), source_id: source.source_id,
    source_version: source.source_version, record_id: source.record_id,
    source_content_digest: source.content_digest, initial_read_bytes: source.read_bytes,
    initial_body_bytes: source.body_bytes, attention: chosen.attention,
    nomination: chosen.nomination,
    active_q_changed_after_nomination: queryReview.changed === true, response: prepared };
  writeChainArtifact(path, result);
  return result;
}
