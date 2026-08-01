import { z } from "zod";
import {
  MembershipAuthorizationSchema,
  NonBlankStringSchema,
  type MembershipAuthorization,
  type MembershipSlot
} from "./packet-plan-membership-schema.js";
export {
  BenchAnswerRerankFailureClassSchema,
  BenchAnswerRerankStatusSchema,
  BenchEvidenceEmbeddingFailureClassSchema,
  BenchEvidenceEmbeddingStatusSchema,
  RecallMultiSeedGraphFanInDiagnosticsSchema
} from "./recall-stage-status-schema.js";

const RecallPacketPlanDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    reason: z.enum(["strict_tail_consensus", "nested_membership_consensus"])
  }).strict().readonly(),
  z.object({
    status: z.literal("no_op"),
    reason: z.enum(["no_finite_embedding_head", "unchanged_consensus"])
  }).strict().readonly(),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum([
      "admission_infeasible",
      "cardinality_mismatch",
      "protected_candidate_constraint"
    ])
  }).strict().readonly()
]);

const RecallPacketPlanEmbeddingRankSchema = z
  .object({
    candidate_key: NonBlankStringSchema,
    embedding_rank: z.number().int().positive()
  })
  .strict()
  .readonly();

const RecallPacketPlanProtectionSchema = z
  .object({
    candidate_key: NonBlankStringSchema,
    rank_limit: z.number().int().positive()
  })
  .strict()
  .readonly();

const RecallPacketPlanTraceShapeSchema = z
  .object({
    schema_version: z.literal(3),
    assessment_path: z.enum(["legacy", "snapshot"]),
    baseline_candidate_keys: z.array(NonBlankStringSchema).readonly(),
    planned_candidate_keys: z.array(NonBlankStringSchema).readonly(),
    actual_candidate_keys: z.array(NonBlankStringSchema).readonly(),
    head_width: z.number().int().nonnegative(),
    baseline_head_candidate_keys: z.array(NonBlankStringSchema).readonly(),
    embedding_head: z.array(RecallPacketPlanEmbeddingRankSchema).readonly(),
    consensus_head_candidate_keys: z.array(NonBlankStringSchema).readonly(),
    immutable_tail_candidate_keys: z.array(NonBlankStringSchema).readonly(),
    tail_policy: z.enum([
      "head_tail_exchange",
      "nested_membership_exchange"
    ]).optional(),
    membership_authorizations: z.array(
      MembershipAuthorizationSchema
    ).readonly(),
    protected_candidates: z.array(RecallPacketPlanProtectionSchema).readonly(),
    added_candidate_keys: z.array(NonBlankStringSchema).readonly(),
    removed_candidate_keys: z.array(NonBlankStringSchema).readonly(),
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
  validatePacketPlanWidths(trace, context);
  validatePacketPlanPartitions(trace, context);
  validatePacketPlanSets(trace, context);
  validateMembershipAuthorizations(trace, context);
  validateTailPolicy(trace, context);
}

function validatePacketPlanWidths(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  const expectedHeadWidth = trace.tail_policy === "nested_membership_exchange"
    ? Math.min(5, trace.baseline_candidate_keys.length)
    : Math.ceil(trace.baseline_candidate_keys.length / 2);
  if (
    trace.head_width !== expectedHeadWidth ||
    trace.baseline_head_candidate_keys.length !== trace.head_width ||
    (trace.decision.reason !== "cardinality_mismatch" &&
      trace.consensus_head_candidate_keys.length !== trace.head_width)
  ) {
    addPacketPlanIssue(context, ["head_width"], "Packet plan head width is inconsistent");
  }
  if (!sameOrderedKeys(
    trace.baseline_head_candidate_keys,
    trace.baseline_candidate_keys.slice(0, trace.head_width)
  )) {
    addPacketPlanIssue(
      context,
      ["baseline_head_candidate_keys"],
      "Packet plan baseline head is not a prefix"
    );
  }
}

function validatePacketPlanPartitions(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  const baselinePartition = [
    ...trace.baseline_head_candidate_keys,
    ...trace.immutable_tail_candidate_keys
  ];
  const proposal = [
    ...trace.consensus_head_candidate_keys,
    ...trace.immutable_tail_candidate_keys
  ];
  if (
    trace.decision.reason !== "cardinality_mismatch" &&
    trace.planned_candidate_keys.length !== trace.baseline_candidate_keys.length
  ) {
    addPacketPlanIssue(
      context, ["planned_candidate_keys"], "Packet plan cardinality is inconsistent"
    );
  }
  if (
    trace.tail_policy === undefined &&
    !sameOrderedKeys(trace.baseline_candidate_keys, baselinePartition)
  ) {
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
}

function validateMembershipAuthorizations(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  if (trace.tail_policy === "head_tail_exchange") return;
  const receipts = trace.membership_authorizations;
  if (receipts.length === 0 &&
      ["strict_tail_consensus", "admission_infeasible"].includes(
        trace.decision.reason
      )) return;
  const deliverable = trace.decision.status === "accepted" ||
    trace.decision.reason === "admission_infeasible";
  if (!deliverable) {
    if (receipts.length > 0) {
      addPacketPlanIssue(
        context, ["membership_authorizations"],
        "Rejected packet proposal carries membership authorization"
      );
    }
    return;
  }
  const satisfied = receipts.map((item) => item.satisfied_by_candidate_key);
  const protectedKeys = new Set(
    trace.protected_candidates.map((item) => item.candidate_key)
  );
  const introduced = trace.consensus_head_candidate_keys.filter(
    (key) => !trace.baseline_head_candidate_keys.includes(key) &&
      !protectedKeys.has(key)
  );
  if (new Set(satisfied).size !== satisfied.length ||
      !sameKeySet(introduced, satisfied) ||
      !retainedHeadOrderIsStable(trace) ||
      receipts.some((receipt) => !authorizationIsBound(receipt, trace))) {
    addPacketPlanIssue(
      context, ["membership_authorizations"], "Invalid authorization binding"
    );
  }
}

function retainedHeadOrderIsStable(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>
): boolean {
  const retained = trace.consensus_head_candidate_keys.filter(
    (key) => trace.baseline_head_candidate_keys.includes(key)
  );
  const expected = trace.baseline_head_candidate_keys.filter(
    (key) => trace.consensus_head_candidate_keys.includes(key)
  );
  return sameOrderedKeys(retained, expected);
}

function authorizationIsBound(
  receipt: MembershipAuthorization,
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>
): boolean {
  const index = receipt.satisfied_head_slot - 1;
  if (trace.consensus_head_candidate_keys[index] !== receipt.satisfied_by_candidate_key) {
    return false;
  }
  const displacedKey = trace.baseline_head_candidate_keys[index];
  const expectedDisplaced = displacedKey === undefined ||
    displacedKey === receipt.satisfied_by_candidate_key ? null : displacedKey;
  if (!slotMatches(receipt.displaced_head_baseline, expectedDisplaced, index)) return false;
  const added = trace.membership_authorizations.filter(
    (item) => !trace.baseline_candidate_keys.includes(item.satisfied_by_candidate_key)
  );
  const addedIndex = added.indexOf(receipt);
  const removed = trace.baseline_candidate_keys.filter(
    (key) => !trace.planned_candidate_keys.includes(key)
  );
  const expectedEvicted = addedIndex < 0 ? null : removed[addedIndex] ?? null;
  const evictedIndex = expectedEvicted === null ? -1 :
    trace.baseline_candidate_keys.indexOf(expectedEvicted);
  if (!slotMatches(receipt.evicted_packet_baseline, expectedEvicted, evictedIndex)) {
    return false;
  }
  return witnessIsBound(receipt, trace.head_width);
}

function witnessIsBound(
  receipt: MembershipAuthorization,
  headWidth: number
): boolean {
  if (receipt.kind === "direct_query_evidence") {
    return receipt.witness.rank <= headWidth &&
      receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key;
  }
  if (receipt.kind === "behavior_identity") {
    return receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key;
  }
  if (receipt.kind === "selector_consensus") {
    return receipt.witness.embedding_rank <= headWidth &&
      receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key;
  }
  if (receipt.kind === "graph_path_opportunity") {
    return receipt.witness.graph_expansion_rank <= headWidth &&
      receipt.authorized_candidate_key === receipt.satisfied_by_candidate_key &&
      receipt.witness.target_candidate_key === receipt.satisfied_by_candidate_key;
  }
  return receipt.witness.protected_candidate_key === receipt.authorized_candidate_key &&
    receipt.witness.source_candidate_key === receipt.authorized_candidate_key &&
    receipt.witness.substitute_candidate_key === receipt.satisfied_by_candidate_key &&
    receipt.witness.target_candidate_key === receipt.satisfied_by_candidate_key;
}

function slotMatches(
  slot: MembershipSlot | null,
  expectedKey: string | null,
  expectedIndex: number
): boolean {
  return expectedKey === null
    ? slot === null
    : slot?.candidate_key === expectedKey && slot.slot === expectedIndex + 1;
}

function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key) => right.includes(key));
}

function validateTailPolicy(
  trace: z.infer<typeof RecallPacketPlanTraceShapeSchema>,
  context: z.RefinementCtx
): void {
  const reason = trace.decision.reason;
  const requiresTailPolicy = reason === "nested_membership_consensus";
  const headTailExchange = trace.tail_policy === "head_tail_exchange";
  const permitsTailPolicy = requiresTailPolicy || headTailExchange ||
    reason === "admission_infeasible";
  if ((requiresTailPolicy && trace.tail_policy === undefined) ||
      (!permitsTailPolicy && trace.tail_policy !== undefined)) {
    addPacketPlanIssue(context, ["tail_policy"], "Membership tail policy is inconsistent");
  }
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
  if (trace.protected_candidates.some(
    (entry) => !trace.baseline_candidate_keys.includes(entry.candidate_key)
  )) {
    addPacketPlanIssue(
      context,
      ["protected_candidates"],
      "Packet protection is outside the baseline head contract"
    );
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
    ["strict_tail_consensus", "protected_candidate_constraint"].includes(reason) &&
    ((!hasEmbeddingHead && trace.protected_candidates.length === 0) ||
      !changed)
  ) {
    addPacketPlanIssue(context, ["decision"], "Changed consensus is inconsistent");
  }
  if (
    ["nested_membership_consensus", "admission_infeasible"].includes(reason) &&
    !changed
  ) {
    addPacketPlanIssue(context, ["decision"], "Changed membership is inconsistent");
  }
  if (
    reason === "cardinality_mismatch" &&
    trace.consensus_head_candidate_keys.length === trace.head_width
  ) {
    addPacketPlanIssue(context, ["decision"], "Cardinality rejection has a full head");
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
    ["strict_tail_consensus", "nested_membership_consensus",
      "admission_infeasible"].includes(
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
