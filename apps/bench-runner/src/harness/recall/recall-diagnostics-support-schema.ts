import { z } from "zod";

export const BenchEvidenceEmbeddingStatusSchema = z.enum([
  "not_requested",
  "not_applicable",
  "returned",
  "failed"
]);

export const BenchEvidenceEmbeddingFailureClassSchema = z.enum([
  "provider_unavailable",
  "query_embedding_failed",
  "candidate_embedding_failed",
  "service_error"
]);

export const BenchAnswerRerankStatusSchema = z.enum([
  "not_requested",
  "not_applicable",
  "returned",
  "failed"
]);

export const BenchAnswerRerankFailureClassSchema = z.enum([
  "invalid_score_count",
  "invalid_score_value",
  "service_error"
]);

export const RecallMultiSeedGraphFanInDiagnosticsSchema = z
  .object({
    distinct_seeds: z.number().int().nonnegative(),
    candidates_per_seed_p50: z.number().nonnegative(),
    candidates_per_seed_p95: z.number().nonnegative(),
    dedup_collisions: z.number().int().nonnegative()
  })
  .strict()
  .readonly();

const RecallPacketPlanDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    reason: z.literal("strict_tail_consensus")
  }).strict().readonly(),
  z.object({
    status: z.literal("no_op"),
    reason: z.enum(["no_finite_embedding_head", "unchanged_consensus"])
  }).strict().readonly(),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum([
      "admission_infeasible",
      "behavior_guard_full_abort",
      "cardinality_mismatch",
      "protected_candidate_constraint"
    ])
  }).strict().readonly()
]);

const RecallPacketPlanEmbeddingRankSchema = z
  .object({
    candidate_key: z.string().min(1),
    embedding_rank: z.number().int().positive()
  })
  .strict()
  .readonly();

const RecallPacketPlanProtectionSchema = z
  .object({
    candidate_key: z.string().min(1),
    rank_limit: z.number().int().positive()
  })
  .strict()
  .readonly();

const RecallPacketPlanTraceShapeSchema = z
  .object({
    schema_version: z.literal(2),
    assessment_path: z.enum(["legacy", "snapshot"]),
    baseline_candidate_keys: z.array(z.string().min(1)).readonly(),
    planned_candidate_keys: z.array(z.string().min(1)).readonly(),
    actual_candidate_keys: z.array(z.string().min(1)).readonly(),
    head_width: z.number().int().nonnegative(),
    baseline_head_candidate_keys: z.array(z.string().min(1)).readonly(),
    embedding_head: z.array(RecallPacketPlanEmbeddingRankSchema).readonly(),
    consensus_head_candidate_keys: z.array(z.string().min(1)).readonly(),
    immutable_tail_candidate_keys: z.array(z.string().min(1)).readonly(),
    protected_candidates: z.array(RecallPacketPlanProtectionSchema).readonly(),
    added_candidate_keys: z.array(z.string().min(1)).readonly(),
    removed_candidate_keys: z.array(z.string().min(1)).readonly(),
    decision: RecallPacketPlanDecisionSchema
  })
  .strict()
  .readonly();

export const RecallPacketPlanTraceSchema =
  RecallPacketPlanTraceShapeSchema.superRefine((trace, context) => {
    validatePacketPlanStructure(trace, context);
    validatePacketPlanDecisionReason(trace, context);
    if (
      trace.decision.status === "accepted" &&
      !sameOrderedKeys(trace.planned_candidate_keys, trace.actual_candidate_keys)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actual_candidate_keys"],
        message: "Accepted packet plan must match the actual packet"
      });
    }
    if (
      trace.decision.status === "rejected" &&
      !sameOrderedKeys(trace.baseline_candidate_keys, trace.actual_candidate_keys)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actual_candidate_keys"],
        message: "Rejected packet plan must preserve the baseline packet"
      });
    }
    if (
      trace.decision.status === "no_op" &&
      (!sameOrderedKeys(trace.baseline_candidate_keys, trace.planned_candidate_keys) ||
        !sameOrderedKeys(trace.baseline_candidate_keys, trace.actual_candidate_keys))
    ) {
      context.addIssue({
        code: "custom",
        path: ["planned_candidate_keys"],
        message: "No-op packet plan must preserve the baseline packet"
      });
    }
  });

export type BenchRecallPacketPlanTrace = z.infer<
  typeof RecallPacketPlanTraceSchema
>;

function sameOrderedKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((candidateKey, index) => candidateKey === right[index]);
}

function validatePacketPlanStructure(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  const baselinePartition = [
    ...trace.baseline_head_candidate_keys,
    ...trace.immutable_tail_candidate_keys
  ];
  const headKeys = new Set(trace.consensus_head_candidate_keys);
  const proposal = [
    ...trace.consensus_head_candidate_keys,
    ...trace.baseline_candidate_keys.filter((key) => !headKeys.has(key))
  ].slice(0, trace.baseline_candidate_keys.length);
  if (
    trace.head_width !== Math.ceil(trace.baseline_candidate_keys.length / 2) ||
    trace.baseline_head_candidate_keys.length !== trace.head_width ||
    (trace.decision.reason !== "cardinality_mismatch" &&
      trace.consensus_head_candidate_keys.length !== trace.head_width)
  ) {
    addPacketPlanIssue(context, ["head_width"], "Packet plan head width is inconsistent");
  }
  if (!sameOrderedKeys(trace.baseline_candidate_keys, baselinePartition)) {
    addPacketPlanIssue(
      context,
      ["baseline_head_candidate_keys"],
      "Packet plan baseline partition is inconsistent"
    );
  }
  if (!sameOrderedKeys(trace.planned_candidate_keys, proposal)) {
    addPacketPlanIssue(
      context,
      ["planned_candidate_keys"],
      "Packet plan proposal is inconsistent"
    );
  }
  validatePacketPlanSets(trace, context);
}

function validatePacketPlanSets(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  const keyLists = [
    ["baseline_candidate_keys", trace.baseline_candidate_keys],
    ["planned_candidate_keys", trace.planned_candidate_keys],
    ["actual_candidate_keys", trace.actual_candidate_keys],
    ["embedding_head", trace.embedding_head.map((entry) => entry.candidate_key)],
    [
      "protected_candidates",
      trace.protected_candidates.map((entry) => entry.candidate_key)
    ]
  ] as const;
  for (const [path, keys] of keyLists) {
    if (new Set(keys).size !== keys.length) {
      addPacketPlanIssue(context, [path], `Packet plan ${path} contains duplicate keys`);
    }
  }
  if (trace.embedding_head.some(
    (entry) => entry.embedding_rank > trace.head_width
  )) {
    addPacketPlanIssue(context, ["embedding_head"], "Embedding rank exceeds packet head");
  }
  const added = setDifference(
    trace.planned_candidate_keys,
    trace.baseline_candidate_keys
  );
  const removed = setDifference(
    trace.baseline_candidate_keys,
    trace.planned_candidate_keys
  );
  if (!sameOrderedKeys(trace.added_candidate_keys, added)) {
    addPacketPlanIssue(context, ["added_candidate_keys"], "Added packet keys are inconsistent");
  }
  if (!sameOrderedKeys(trace.removed_candidate_keys, removed)) {
    addPacketPlanIssue(
      context,
      ["removed_candidate_keys"],
      "Removed packet keys are inconsistent"
    );
  }
}

function validatePacketPlanDecisionReason(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  const reason = trace.decision.reason;
  const hasEmbeddingHead = trace.embedding_head.length > 0;
  const changed = !sameOrderedKeys(
    trace.baseline_head_candidate_keys,
    trace.consensus_head_candidate_keys
  );
  if (reason === "no_finite_embedding_head" && hasEmbeddingHead) {
    addPacketPlanIssue(context, ["decision"], "Absent embedding head contains ranks");
  }
  if (reason === "unchanged_consensus" && (!hasEmbeddingHead || changed)) {
    addPacketPlanIssue(context, ["decision"], "Unchanged consensus is inconsistent");
  }
  if (
    ["strict_tail_consensus", "admission_infeasible",
      "behavior_guard_full_abort", "protected_candidate_constraint"].includes(reason) &&
    (!hasEmbeddingHead || !changed)
  ) {
    addPacketPlanIssue(context, ["decision"], "Changed consensus is inconsistent");
  }
  if (
    reason === "cardinality_mismatch" &&
    trace.consensus_head_candidate_keys.length === trace.head_width &&
    trace.planned_candidate_keys.length === trace.baseline_candidate_keys.length &&
    new Set(trace.planned_candidate_keys).size ===
      trace.baseline_candidate_keys.length
  ) {
    addPacketPlanIssue(context, ["decision"], "Cardinality rejection has a complete proposal");
  }
  validateProtectionDecision(trace, context);
}

function validateProtectionDecision(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  const protectionsSatisfied = trace.protected_candidates.every(
    ({ candidate_key: candidateKey, rank_limit: rankLimit }) => {
      const rank = trace.planned_candidate_keys.indexOf(candidateKey) + 1;
      return rank > 0 && rank <= rankLimit;
    }
  );
  if (
    trace.decision.reason === "protected_candidate_constraint" &&
    protectionsSatisfied
  ) {
    addPacketPlanIssue(context, ["decision"], "No protected constraint was violated");
  }
  if (
    ["strict_tail_consensus", "admission_infeasible"].includes(
      trace.decision.reason
    ) &&
    !protectionsSatisfied
  ) {
    addPacketPlanIssue(context, ["decision"], "Protected candidate constraint was violated");
  }
}

function setDifference(
  values: readonly string[],
  excluded: readonly string[]
): readonly string[] {
  const excludedSet = new Set(excluded);
  return values.filter((value) => !excludedSet.has(value));
}

function addPacketPlanIssue(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}
