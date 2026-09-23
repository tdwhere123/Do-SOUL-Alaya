import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AlayaError, canonicalJson, SourceSemanticResourceLedger,
  type SourceSemanticReasoningResult } from "@do-soul/alaya-protocol";
import { authorizedScopesFromAdmission, executeSourceSemanticInterpretation, fieldContractSha256,
  semanticInterpretationEvidenceId, verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { restoreSnapshotToDataDir } from "../snapshot/materialize.js";
import { sourceLookupStores } from "../snapshot/source-records/publish.js";
import { chainIdentity, readChainArtifact, writeChainArtifact } from "./contract.js";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { readSemanticChainCorrespondences } from "./inputs.js";
import { admitSemanticChainReplay } from "./replay.js";

const WITHDRAWAL_CONTRACT = "source-semantic-chain-withdrawal-v3" as const;

/** A new offline execution, with all withdrawal arms sharing its original compiled state. */
export function interveneSemanticChain(root: string, replayPath: string, leafTrials = 32) {
  if (!Number.isInteger(leafTrials) || leafTrials < 1 || leafTrials > 64) throw new AlayaError("VALIDATION", "leaf trials must be 1..64");
  const { plan, replay } = admitSemanticChainReplay(root, replayPath);
  if (replay.arm !== "retained") throw new AlayaError("VALIDATION", "withdrawal requires the retained replay arm");
  const { semantic_correspondences, identity: currentReplayIdentity } = readSemanticChainCorrespondences(plan, "retained");
  if (currentReplayIdentity !== replay.identity) throw new AlayaError("CONFLICT", "retained native semantic-correspondence state changed");
  const identity = chainIdentity({ contract: WITHDRAWAL_CONTRACT,
    plan: replay.plan_identity, replay: chainIdentity(replay), leafTrials });
  const path = join(root, `withdrawal-${identity}.json`);
  const prior = readChainArtifact(path);
  if (prior !== undefined) return { path, result: prior };
  const directory = mkdtempSync(join(root, "withdrawal-session-"));
  const filename = join(directory, "alaya.db");
  const rows: unknown[] = [];
  try {
    restoreSnapshotToDataDir({ snapshotDbPath: plan.config.snapshot_path,
      expectedSha256: plan.config.snapshot_sha256, dataDirRoot: directory });
    const database = initDatabase({ filename });
    const scopes = authorizedScopesFromAdmission(plan.config.authorized_scopes).authorized_scopes;
    if (scopes === undefined) throw new AlayaError("CONFLICT", "withdrawal requires explicit scope admission");
    for (const query of plan.queries) {
      const retainedRow = replay.rows.find((row) => row.query_key === query.query_key);
      const native = retainedRow?.status === "replayed" ? retainedRow.response : undefined;
      const proofs = native?.operation === "recall" ? native.proofs ?? [] : [];
      if (query.status !== "ready" || proofs.length === 0) {
        rows.push({ query_key: query.query_key, status: "not_exercised", reason: "no_retained_native_proof" }); continue;
      }
      for (const proof of proofs) {
        const found = semantic_correspondences.find((row) => {
          const request = row.line.request as SourceSemanticCorrespondenceRequest;
          return row.line.original_query === query.original_query && request.source_interpretation_descriptors[0]?.source_interpretation_id === proof.source_interpretation_id
            && canonicalJson(request.admitted_query_semantics) === canonicalJson(query.query_semantics);
        });
        if (found?.received === undefined || !("semantic_correspondence" in found.received) || found.received.semantic_correspondence === undefined) {
          throw new AlayaError("CONFLICT", "retained native proof lacks its exact available semantic correspondence");
        }
        if (!retainedRow?.correspondence_outcomes?.some((row) => row.key === found.line.key
          && row.raw_digest === found.shard?.raw_digest)) throw new AlayaError("CONFLICT", "retained native semantic-correspondence artifact changed");
        const capsule = new SqliteSourceHintReader(database.connection).readBoundInterpretation(plan.config.workspace_id,
          semanticInterpretationEvidenceId(proof.source_interpretation_id!, fieldContractSha256), plan.config.budget.memory_bytes);
        if (capsule.status !== "complete" || capsule.gist === null) throw new AlayaError("CONFLICT", "withdrawal source interpretation unavailable in snapshot");
        const checked = verifyPublishedSourceSemanticInterpretation({ stores: sourceLookupStores(database),
          sha256: fieldContractSha256, meter: new SourceSemanticResourceLedger(plan.config.budget) },
        JSON.parse(capsule.gist), plan.config.workspace_id);
        const executed = executeSourceSemanticInterpretation({
          source_interpretation: checked.bound, query_semantics: query.query_semantics, semantic_correspondence: found.received.semantic_correspondence,
          original_query: query.original_query, workspaceId: plan.config.workspace_id,
          scope: checked.stored.record.scope_class ?? "project", authorizedScopes: scopes,
          asOf: plan.config.interpretation_clock, sourceValidity: checked.stored.record,
          source_target: checked.bound.source_target, withdrawal_trial_limit: leafTrials,
          request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
            source_interpretation_id: proof.source_interpretation_id!, query_semantics_id: proof.query_semantics_id!, semantic_correspondence_id: proof.semantic_correspondence_id!, original_query: query.original_query,
            budget: plan.config.budget, output_byte_limit: plan.config.output_byte_limit } });
        const sameContext = ["conditional_computation_id", "source_interpretation_id", "query_semantics_id", "semantic_correspondence_id"] as const;
        const matched = executed.result.outcome.status === "interpreted"
          && sameContext.every((key) => executed.result[key] === proof[key])
          && canonicalJson(answerKeys(executed.result)) === canonicalJson(answerKeys(proof));
        rows.push({ query_key: query.query_key, status: matched ? "diagnosed" : "baseline_mismatch",
          native_proof: proof, baseline: executed.result, correspondence_key: found.line.key,
          correspondence_raw_digest: found.shard?.raw_digest ?? null, trace: executed.withdrawal_trace ?? null,
          effects: matched ? executed.withdrawal_trace?.arms.map((arm) => ({ leaf_id: arm.leaf_id,
            leaf_kind: arm.leaf.leaf_kind, status: arm.result.outcome.status === "interpreted" ? "evaluated" : "unresolved",
            removed_answers: arm.result.outcome.status !== "interpreted" ? null
              : answerKeys(executed.result).filter((key) => !answerKeys(arm.result).includes(key)),
            preserved_answers: arm.result.outcome.status !== "interpreted" ? null
              : answerKeys(executed.result).filter((key) => answerKeys(arm.result).includes(key)) })) ?? [] : [] });
      }
    }
  } finally { closeCachedDatabase(filename); }
  const result = { contract: WITHDRAWAL_CONTRACT, identity,
    execution_origin: "new_offline_compilation_with_same_state_arms", provider_calls: 0,
    plan_identity: replay.plan_identity, replay_identity: replay.identity, leaf_trials: leafTrials, rows };
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) {
    throw new AlayaError("CONFLICT", "withdrawal trace exceeds artifact byte bound; lower --leaf-trials; working snapshot retained");
  }
  writeChainArtifact(path, result);
  rmSync(directory, { recursive: true, force: true });
  return { path, result };
}

function answerKeys(result: SourceSemanticReasoningResult): string[] {
  // Witness changes stay in the full trace; equal targets with alternate support remain one answer.
  return [...new Set((result.binding_results ?? []).map((row) => canonicalJson({
    kind: row.kind, ...(row.kind === "evidence" ? { input: row.input } : {}),
    alternative: row.alternative, query_complete: row.query_complete,
    returned: row.returned, bindings: row.bindings })))].sort();
}
