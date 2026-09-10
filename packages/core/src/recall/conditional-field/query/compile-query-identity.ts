import { createHash } from "node:crypto";
import {
  formatConditionalFieldDigest,
  type Continuation,
  type Guard,
  type QueryHypothesis,
  type QueryInterpretationProposal,
  type QueryProgram,
  type QueryTimeWindow,
  type QueryView
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../../shared/stable-stringify.js";

export type QueryDenotationParts = Readonly<{
  readonly program: QueryProgram;
  readonly source_guard?: Guard;
  readonly view?: QueryView;
  readonly hypotheses?: readonly QueryHypothesis[];
  readonly interpretation_clock?: string;
  readonly time_window?: QueryTimeWindow;
  readonly authorized_scopes?: readonly string[];
  readonly lexical_text?: string;
  readonly ordinary_request?: unknown;
  readonly interpretation_proposal?: QueryInterpretationProposal;
}>;

export function digestOriginalQuery(text: string): string {
  return formatConditionalFieldDigest(createHash("sha256").update(text, "utf8").digest("hex"));
}

export function identityFor(queryId: string | undefined, parts: QueryDenotationParts): string {
  if (queryId !== undefined) return queryId;
  return formatConditionalFieldDigest(
    createHash("sha256").update(stableStringify({
      program: parts.program,
      view: parts.view ?? null,
      hypotheses: parts.hypotheses ?? [],
      interpretation_clock: parts.interpretation_clock ?? null,
      time_window: parts.time_window ?? null,
      authorized_scopes: [...(parts.authorized_scopes ?? [])].sort(),
      lexical_text: parts.lexical_text ?? "",
      ordinary_request: parts.ordinary_request ?? null,
      source_guard: parts.source_guard ?? null,
      interpretation_proposal: parts.interpretation_proposal === undefined
        ? null
        : {
          original_query_digest: parts.interpretation_proposal.original_query_digest,
          producer_id: parts.interpretation_proposal.producer_id,
          stored_cosine_admission: parts.interpretation_proposal.stored_cosine_admission ?? null,
          conditions: parts.interpretation_proposal.conditions ?? null,
          input_limits: parts.interpretation_proposal.input_limits ?? null,
          program: parts.interpretation_proposal.program ?? null,
          holes: parts.interpretation_proposal.holes ?? null,
          hypotheses: parts.interpretation_proposal.hypotheses ?? null
        }
    }), "utf8").digest("hex")
  );
}

export function interpretationIdentity(input: Readonly<{
  readonly interpretation_clock?: string;
  readonly model_id?: string;
}>): string {
  return formatConditionalFieldDigest(
    createHash("sha256").update(stableStringify({
      interpretation_clock: input.interpretation_clock ?? null,
      model_id: input.model_id ?? null
    }), "utf8").digest("hex")
  );
}

export function proposalBindsOriginalQuery(
  proposal: QueryInterpretationProposal,
  originalQuery: string
): boolean {
  return proposal.original_query_digest === digestOriginalQuery(originalQuery);
}

export function continuationViewMismatch(
  continuation: Continuation | null | undefined,
  view: QueryView,
  authorizedScopes?: readonly string[]
): boolean {
  if (continuation === undefined || continuation === null) return false;
  const policy = continuation.enumeration_policy ?? "canonical";
  const kindView = continuation.result_kind_view ?? "mixed";
  if (policy !== (view.enumeration_policy ?? "canonical")) return true;
  if (kindView !== (view.result_kind_view ?? "mixed")) return true;
  if ((continuation.protocol_version ?? null) !== (view.protocol_version ?? null)) return true;
  if (stableStringify([...(continuation.supported_result_kinds ?? [])].sort())
    !== stableStringify([...(view.supported_result_kinds ?? [])].sort())) return true;
  if (stableStringify(continuation.cap_contracts ?? null) !== stableStringify(view.cap_contracts ?? null)) return true;
  if (stableStringify(continuation.claim_demands ?? null) !== stableStringify(view.claim_demands ?? null)) return true;
  if (continuation.authorized_scopes === undefined || authorizedScopes === undefined) return false;
  return stableStringify([...(continuation.authorized_scopes)].sort())
    !== stableStringify([...authorizedScopes].sort());
}
