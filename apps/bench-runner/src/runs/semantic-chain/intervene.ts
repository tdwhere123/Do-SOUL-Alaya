import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, SoulInterpretationResponseSchema, SourceSemanticResourceLedger,
  type SourceSemanticReasoningResult } from "@do-soul/alaya-protocol";
import { authorizedScopesFromAdmission, executeSourceSemanticInterpretation, fieldContractSha256,
  semanticInterpretationEvidenceId, verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { restoreSnapshotToDataDir } from "../snapshot/materialize.js";
import { sourceLookupStores } from "../snapshot/source-records/publish.js";
import { SemanticChainPlanSchema, assertChainSnapshot, chainIdentity, readChainArtifact, writeChainArtifact } from "./contract.js";
import type { SourceSemanticAlignmentRequest } from "@do-soul/alaya-soul";
import { readSemanticChainAlignments, verifySemanticChainQueries } from "./inputs.js";

const replaySchema = z.object({ contract: z.literal("source-semantic-chain-replay-v1"),
  plan_identity: z.string(), identity: z.string(), arm: z.literal("retained"),
  rows: z.array(z.object({ query_key: z.string(), response: SoulInterpretationResponseSchema.optional(),
    alignment_outcomes: z.array(z.object({ key: z.string().nullable(), raw_digest: z.string().nullable() }).passthrough()).optional()
  }).passthrough())
}).passthrough();

/** A new offline execution, with all withdrawal arms sharing its original compiled state. */
export function interveneSemanticChain(root: string, replayPath: string, leafTrials = 32) {
  if (!Number.isInteger(leafTrials) || leafTrials < 1 || leafTrials > 64) throw new Error("leaf trials must be 1..64");
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  assertChainSnapshot(plan.config);
  verifySemanticChainQueries(plan);
  const replay = replaySchema.parse(readChainArtifact(replayPath));
  if (replay.plan_identity !== chainIdentity(plan)) throw new Error("withdrawal replay does not bind this plan");
  const expected = plan.queries.map((row) => row.query_key).sort();
  const retained = replay.rows.map((row) => row.query_key).sort();
  if (canonicalJson(expected) !== canonicalJson(retained)) throw new Error("withdrawal replay requires exact query denominator");
  const { alignments, identity: currentReplayIdentity } = readSemanticChainAlignments(plan, "retained");
  if (currentReplayIdentity !== replay.identity) throw new Error("retained native A state changed");
  const identity = chainIdentity({ plan: replay.plan_identity, replay: replay.identity, leafTrials });
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
    if (scopes === undefined) throw new Error("withdrawal requires explicit scope admission");
    for (const query of plan.queries) {
      const retainedRow = replay.rows.find((row) => row.query_key === query.query_key);
      const native = retainedRow?.response;
      const proofs = native?.operation === "recall" ? native.proofs ?? [] : [];
      if (query.status !== "ready" || proofs.length === 0) {
        rows.push({ query_key: query.query_key, status: "not_exercised", reason: "no_retained_native_proof" }); continue;
      }
      for (const proof of proofs) {
        const found = alignments.find((row) => {
          const request = row.line.request as SourceSemanticAlignmentRequest;
          return row.line.original_query === query.original_query && request.h_descriptors[0]?.h_id === proof.h_id
            && canonicalJson(request.admitted_q) === canonicalJson(query.q);
        });
        if (found?.received === undefined || !("alignment" in found.received) || found.received.alignment === undefined) {
          throw new Error("retained native proof lacks its exact available A");
        }
        if (!retainedRow?.alignment_outcomes?.some((row) => row.key === found.line.key
          && row.raw_digest === found.shard?.raw_digest)) throw new Error("retained native A artifact changed");
        const capsule = new SqliteSourceHintReader(database.connection).readBoundInterpretation(plan.config.workspace_id,
          semanticInterpretationEvidenceId(proof.h_id!, fieldContractSha256), plan.config.budget.memory_bytes);
        if (capsule.status !== "complete" || capsule.gist === null) throw new Error("withdrawal H unavailable in snapshot");
        const checked = verifyPublishedSourceSemanticInterpretation({ stores: sourceLookupStores(database),
          sha256: fieldContractSha256, meter: new SourceSemanticResourceLedger(plan.config.budget) },
        JSON.parse(capsule.gist), plan.config.workspace_id);
        const executed = executeSourceSemanticInterpretation({ h: checked.bound, q: query.q, a: found.received.alignment,
          original_query: query.original_query, workspaceId: plan.config.workspace_id,
          scope: checked.stored.record.scope_class ?? "project", authorizedScopes: scopes,
          asOf: plan.config.interpretation_clock, sourceValidity: checked.stored.record,
          source_target: checked.bound.source_target, withdrawal_trial_limit: leafTrials,
          request: { contract: "source-interpretation-reasoning-v3", accepts_unreviewed_conditional_results: true,
            h_id: proof.h_id!, q_id: proof.q_id!, a_id: proof.a_id!, original_query: query.original_query,
            budget: plan.config.budget, output_byte_limit: plan.config.output_byte_limit } });
        const sameContext = ["c_id", "h_id", "q_id", "a_id"] as const;
        const matched = executed.result.outcome.status === "interpreted"
          && sameContext.every((key) => executed.result[key] === proof[key])
          && canonicalJson(answerKeys(executed.result)) === canonicalJson(answerKeys(proof));
        rows.push({ query_key: query.query_key, status: matched ? "diagnosed" : "baseline_mismatch",
          native_proof: proof, baseline: executed.result, alignment_key: found.line.key,
          alignment_raw_digest: found.shard?.raw_digest ?? null, trace: executed.withdrawal_trace ?? null,
          effects: matched ? executed.withdrawal_trace?.arms.map((arm) => ({ leaf_id: arm.leaf_id,
            leaf_kind: arm.leaf.leaf_kind, status: arm.result.outcome.status === "interpreted" ? "evaluated" : "unresolved",
            removed_answers: arm.result.outcome.status !== "interpreted" ? null
              : answerKeys(executed.result).filter((key) => !answerKeys(arm.result).includes(key)),
            preserved_answers: arm.result.outcome.status !== "interpreted" ? null
              : answerKeys(executed.result).filter((key) => answerKeys(arm.result).includes(key)) })) ?? [] : [] });
      }
    }
  } finally { closeCachedDatabase(filename); }
  const result = { contract: "source-semantic-chain-withdrawal-v1", identity,
    execution_origin: "new_offline_compilation_with_same_state_arms", provider_calls: 0,
    plan_identity: replay.plan_identity, replay_identity: replay.identity, leaf_trials: leafTrials, rows };
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) {
    throw new Error("withdrawal trace exceeds artifact byte bound; lower --leaf-trials; working snapshot retained");
  }
  writeChainArtifact(path, result);
  rmSync(directory, { recursive: true, force: true });
  return { path, result };
}

function answerKeys(result: SourceSemanticReasoningResult): string[] {
  return [...new Set((result.answers ?? []).map((row) => canonicalJson({ alternative: row.alternative,
    returned: row.returned, bindings: row.bindings })))].sort();
}
