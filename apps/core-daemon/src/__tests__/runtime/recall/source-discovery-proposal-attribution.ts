import {
  canonicalJson, QueryInterpretationProposalSchema, sourceEvidenceRootTarget, sourceRecallTarget,
  type BoundSourceInterpretation, type SoulMemorySearchRequest, type SourceEvidenceTarget
} from "@do-soul/alaya-protocol";
import { matchBoundInterpretation, type ProposalMatchReason } from
  "../../../../../../packages/core/src/recall/conditional-field/observers/source-proposal-match.js";
import { adoptedSourceProposal } from
  "../../../../../../packages/core/src/recall/conditional-field/query/query-source-proposal.js";
import type { BoundPublicReceive, BoundPublicSource } from "./source-discovery-admitted-public-publication.js";
import type { ConsumptionTrace } from "./source-discovery-public-consumption.js";

export type ProposalExposure = Readonly<{
  readonly status: "observed" | "not_observed" | "unavailable" | "not_applicable";
  readonly witnesses: readonly Readonly<{
    readonly step_index: number;
    readonly query_id: string;
    readonly interpretation_id: string;
    readonly snapshot_id: string;
    readonly request_key: string | null;
    readonly assertion_id: number;
    readonly artifact_key: string;
    readonly reason: ProposalMatchReason;
  }>[];
}>;

/** Public exposure is a necessary witness, not proof of semantic truth, agent use, or causal benefit. */
export function observePublishedProposalExposure(input: Readonly<{
  readonly trace: ConsumptionTrace;
  readonly firstCompleteStep: number | null;
  readonly request: SoulMemorySearchRequest;
  readonly bind: BoundPublicReceive;
  readonly source: BoundPublicSource;
  readonly workspaceId: string;
  readonly publications?: readonly BoundSourceInterpretation[];
}>): ProposalExposure {
  const proposal = input.request.interpretation_proposal;
  const parsed = QueryInterpretationProposalSchema.safeParse(proposal);
  if (proposal != null && !parsed.success) return { status: "unavailable", witnesses: [] };
  const sketch = parsed.success ? adoptedSourceProposal({ interpretation_proposal: parsed.data }) : undefined;
  if (sketch?.lookup_mode !== "proposal") return { status: "not_applicable", witnesses: [] };
  if (input.bind.status !== "complete" || input.firstCompleteStep === null) {
    return { status: "unavailable", witnesses: [] };
  }
  const completeReceipt = input.trace.steps[input.firstCompleteStep]?.public_exchange.receipt;
  if (completeReceipt === undefined || completeReceipt === "unavailable") {
    return { status: "unavailable", witnesses: [] };
  }
  const expectedTarget = sourceRecallTarget({ workspace_id: input.workspaceId, root_kind: "source_record",
    root_id: input.source.rootId, source_version: "v1", content_digest: input.source.digest,
    evidence_object_id: input.source.evidenceObjectId });
  const witnesses: ProposalExposure["witnesses"][number][] = [];
  let evidenceAvailable = true;
  for (const [index, step] of input.trace.steps.slice(0, input.firstCompleteStep + 1).entries()) {
    const exchange = step.public_exchange;
    if (exchange.response.source_lookups === undefined || exchange.receipt === "unavailable") {
      evidenceAvailable = false;
      continue;
    }
    if (exchange.step_index !== index || exchange.request.query !== input.request.query ||
      canonicalJson(exchange.request.interpretation_proposal) !== canonicalJson(proposal ?? null) ||
      exchange.receipt.query_id !== completeReceipt.query_id ||
      exchange.receipt.interpretation_id !== completeReceipt.interpretation_id ||
      exchange.receipt.snapshot_id !== completeReceipt.snapshot_id) continue;
    for (const observed of exchange.response.source_lookups) {
      if (observed.target.kind !== "source_evidence" || !sameSource(observed.target, expectedTarget)) continue;
      if (observed.reasons === undefined || observed.reasons === "unavailable") continue;
      for (const reason of observed.reasons) {
        if (!sameSource(reason.source_target, expectedTarget)) continue;
        const located = input.bind.receive.located.find((row) => row.outcome === "candidates" &&
          row.assertion_binding.context_id === reason.context_id &&
          row.candidates.some((candidate) => candidate.candidate_id === reason.candidate_id));
        if (located?.outcome !== "candidates") continue;
        const publication = input.publications?.find((bound) => bound.assertion_binding.context_id === reason.context_id &&
          bound.candidates.some((candidate) => candidate.candidate_id === reason.candidate_id));
        if (input.publications !== undefined && (publication === undefined || !sameSource(publication.source_target, expectedTarget))) continue;
        const bound = publication ?? { ...located, source_target: expectedTarget };
        const expected = matchBoundInterpretation({ ...bound,
          candidates: bound.candidates.filter((candidate) => candidate.candidate_id === reason.candidate_id) }, sketch);
        if (expected === undefined || canonicalJson(expected) !== canonicalJson(reason)) continue;
        witnesses.push({ step_index: index, query_id: exchange.receipt.query_id,
          interpretation_id: exchange.receipt.interpretation_id, snapshot_id: exchange.receipt.snapshot_id,
          request_key: input.bind.cacheKey ?? null, assertion_id: located.assertion_binding.assertion_id,
          artifact_key: located.artifact_key, reason });
      }
    }
  }
  return { status: witnesses.length > 0 ? "observed" : evidenceAvailable ? "not_observed" : "unavailable", witnesses };
}

function sameSource(left: SourceEvidenceTarget, right: SourceEvidenceTarget): boolean {
  return canonicalJson(sourceEvidenceRootTarget(left)) === canonicalJson(sourceEvidenceRootTarget(right));
}
