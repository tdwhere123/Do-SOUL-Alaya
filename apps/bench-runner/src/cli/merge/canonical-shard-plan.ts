import type { KpiPayload } from "@do-soul/alaya-eval";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import type { LongMemEvalDiagnosticsSpool } from
  "../../longmemeval/diagnostics/spool.js";
import { pct } from "../result-format.js";
import {
  isCurrentStreamedDiagnostics,
  materializeShardPayload,
  readShardPayloadPlan
} from "./shard-diagnostics-reader.js";
import type { VerifiedShardEvidence } from "./shard-evidence-verifier.js";
import { canonicalizeVerifiedShards } from "./shard-ordering.js";

export interface ShardArchiveRef {
  readonly root: string;
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly diagnostics: LongMemEvalDiagnosticsSidecar;
  readonly verifiedEvidence: VerifiedShardEvidence | null;
}

export interface LoadedMergeShards {
  readonly payloads: readonly KpiPayload[];
  readonly archiveRefs: readonly ShardArchiveRef[];
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly first: KpiPayload;
}

export async function loadCanonicalMergeShards(
  shards: readonly string[],
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LoadedMergeShards> {
  const planned = [];
  for (const shardRoot of shards) {
    const plan = await readShardPayloadPlan(shardRoot);
    planned.push(plan);
    process.stdout.write(
      `  shard ${shardRoot}: ${plan.payload.evaluated_count} questions, ` +
        `R@5=${pct(plan.payload.kpi.r_at_5)}\n`
    );
  }
  const ordered = canonicalizeVerifiedShards(planned);
  const materialized = [];
  for (const plan of ordered) {
    materialized.push({
      root: plan.root,
      ...await materializeShardPayload(plan, diagnosticsSpool)
    });
  }
  return assembleLoadedShards(materialized, diagnosticsSpool);
}

function assembleLoadedShards(
  ordered: readonly ShardArchiveRefWithQuestions[],
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): LoadedMergeShards {
  const payloads = ordered.map((item) => item.payload);
  const archiveRefs = ordered.map(({ questionDiagnostics: _questions, ...item }) => item);
  const questionDiagnostics = ordered.flatMap((item) => item.questionDiagnostics);
  const first = payloads[0];
  if (first === undefined) throw new Error("no shards loaded");
  assertCurrentDiagnosticsSpoolCount(payloads, archiveRefs, diagnosticsSpool);
  return { payloads, archiveRefs, questionDiagnostics, first };
}

type ShardArchiveRefWithQuestions = ShardArchiveRef & Readonly<{
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
}>;

function assertCurrentDiagnosticsSpoolCount(
  payloads: readonly KpiPayload[],
  archiveRefs: readonly ShardArchiveRef[],
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): void {
  if (!archiveRefs.every((shard) => isCurrentStreamedDiagnostics(shard.diagnostics))) return;
  const evaluatedCount = payloads.reduce(
    (total, payload) => total + payload.evaluated_count,
    0
  );
  if (diagnosticsSpool.questionCount !== evaluatedCount) {
    throw new Error(
      `merged evaluated_count=${evaluatedCount} does not match ` +
        `diagnostics spool question count=${diagnosticsSpool.questionCount}`
    );
  }
}
