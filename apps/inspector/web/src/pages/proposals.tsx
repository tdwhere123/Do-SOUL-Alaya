import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useToasts } from "../components/toast";
import { useI18n } from "../i18n/locale";
import type { DictKey } from "../i18n/dict";

interface PendingSummary {
  readonly proposal_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly created_at: string;
  readonly proposed_change_summary: string;
  readonly proposed_changes: Record<string, unknown> | null;
}

interface PendingEnvelope {
  readonly success: boolean;
  readonly data: { readonly proposals: readonly PendingSummary[]; readonly total_count: number };
}

interface ReviewEnvelope {
  readonly success: boolean;
  readonly data?: { readonly proposal_id: string; readonly resolution_state: string };
}

const RESOLUTION_STATE_KEYS: Readonly<Record<string, DictKey>> = {
  accepted: "proposals:status.accepted",
  rejected: "proposals:status.rejected",
  pending: "proposals:status.pending"
};

export default function ProposalsPage() {
  const controller = useProposalsController();
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-6">
        <ProposalHeader controller={controller} />
        <ProposalLoadState controller={controller} />
        <ul className="space-y-4">
          {controller.proposals.map((proposal) => (
            <ProposalRow key={proposal.proposal_id} proposal={proposal} controller={controller} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function useProposalsController() {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId();
  const [reviewer, setReviewer] = useState("");
  const [reasonByProposal, setReasonByProposal] = useState<Record<string, string>>({});
  const [busyProposalIds, setBusyProposalIds] = useState<ReadonlySet<string>>(() => new Set());
  const [searchParams] = useSearchParams();
  const highlightedRowRef = useRef<HTMLLIElement | null>(null);
  const highlightedProposalId = searchParams.get("highlight");
  const fetchProposals = useCallback(
    (signal: AbortSignal) => fetchPendingProposals(workspaceId, signal),
    [workspaceId]
  );
  const query = useApiQuery(fetchProposals, [workspaceId], { enabled: workspaceId !== null });
  const proposals = query.data ?? [];

  useEffect(() => focusHighlightedProposal(highlightedProposalId, highlightedRowRef), [
    highlightedProposalId,
    proposals
  ]);

  const submitReview = useCallback(
    (proposalId: string, verdict: "accept" | "reject") =>
      submitProposalReview({
        proposalId, verdict, reviewer, reasonByProposal, refetch: query.refetch,
        setBusyProposalIds, showToast, t, workspaceId
      }),
    [query.refetch, reasonByProposal, reviewer, showToast, t, workspaceId]
  );
  return {
    busyProposalIds, highlightedProposalId, highlightedRowRef, loadError: workspaceId === null ? t("proposals:loadFailedNoWorkspace") : query.error,
    loading: query.loading, proposals, reasonByProposal, reviewer, setReasonByProposal, setReviewer, submitReview, t
  };
}

function ProposalHeader({ controller }: { readonly controller: ReturnType<typeof useProposalsController> }) {
  return (
    <>
      <h1 className="mb-4 font-mono text-2xl font-bold uppercase tracking-widest text-ink-600">
        {controller.t("proposals:title")}
      </h1>
      <div className="mb-6">
        <label htmlFor="proposal-reviewer-identity" className="mb-1 block font-mono text-sm text-ink-700">
          {controller.t("proposals:reviewer.label")}
        </label>
        <input
          id="proposal-reviewer-identity"
          type="text"
          value={controller.reviewer}
          onChange={(event) => controller.setReviewer(event.target.value)}
          placeholder={controller.t("proposals:reviewer.placeholder")}
          className="w-full rounded border border-beige-300 bg-beige-100 px-3 py-2 font-mono text-sm"
        />
      </div>
    </>
  );
}

function ProposalLoadState({ controller }: { readonly controller: ReturnType<typeof useProposalsController> }) {
  return (
    <>
      {controller.loading ? <p className="font-mono text-sm text-ink-600">{controller.t("proposals:loading")}</p> : null}
      {controller.loadError !== null ? (
        <p className="font-mono text-sm text-red-700">
          {controller.t("proposals:errorPrefix", { message: controller.loadError })}
        </p>
      ) : null}
      {!controller.loading && controller.proposals.length === 0 ? (
        <p className="font-mono text-sm text-ink-700">{controller.t("proposals:empty")}</p>
      ) : null}
    </>
  );
}

function ProposalRow(props: {
  readonly proposal: PendingSummary;
  readonly controller: ReturnType<typeof useProposalsController>;
}) {
  const { controller, proposal } = props;
  const isHighlighted = proposal.proposal_id === controller.highlightedProposalId;
  const proposedChangesDisplay = formatProposedChanges(proposal.proposed_changes);
  const reasonInputId = `review-reason-${proposal.proposal_id}`;
  return (
    <li
      ref={isHighlighted ? controller.highlightedRowRef : undefined}
      tabIndex={isHighlighted ? -1 : undefined}
      aria-current={isHighlighted ? "true" : undefined}
      className={isHighlighted ? "rounded border-2 border-state-emphasis bg-beige-100 p-4" : "rounded border border-beige-300 bg-beige-100 p-4"}
    >
      <ProposalSummary proposal={proposal} t={controller.t} />
      <ProposedChangesPanel display={proposedChangesDisplay} t={controller.t} />
      <ReviewReasonInput controller={controller} proposal={proposal} reasonInputId={reasonInputId} />
      <ProposalActions
        canAccept={proposedChangesDisplay !== null}
        busy={controller.busyProposalIds.has(proposal.proposal_id)}
        proposalId={proposal.proposal_id}
        submitReview={controller.submitReview}
        t={controller.t}
      />
    </li>
  );
}

function ProposalSummary(props: {
  readonly proposal: PendingSummary;
  readonly t: ReturnType<typeof useI18n>["t"];
}) {
  const { proposal, t } = props;
  return (
    <>
      <div className="mb-2 font-mono text-xs text-ink-500">{proposal.proposal_id}</div>
      <div className="mb-2 font-mono text-sm text-ink-600">
        {proposal.target_object_kind} {t("proposals:row.targetSeparator")} {proposal.target_object_id}
      </div>
      <div className="mb-3 text-sm text-ink-700">{proposal.proposed_change_summary}</div>
      <div className="mb-3 font-mono text-xs text-ink-500">
        {t("proposals:row.createdAt", { ts: proposal.created_at })}
      </div>
    </>
  );
}

function ProposedChangesPanel(props: {
  readonly display: string | null;
  readonly t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <div className="mb-3 rounded border border-beige-300 bg-white p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-500">
        {props.t("proposals:row.proposedChanges")}
      </div>
      {props.display === null ? (
        <p className="font-mono text-xs text-red-700">{props.t("proposals:row.proposedChangesUnavailable")}</p>
      ) : (
        <pre className="max-h-56 overflow-auto break-words whitespace-pre-wrap font-mono text-xs text-ink-600">
          {props.display}
        </pre>
      )}
    </div>
  );
}

function ReviewReasonInput(props: {
  readonly controller: ReturnType<typeof useProposalsController>;
  readonly proposal: PendingSummary;
  readonly reasonInputId: string;
}) {
  return (
    <>
      <label htmlFor={props.reasonInputId} className="sr-only">
        {props.controller.t("proposals:row.reasonAria", { id: props.proposal.proposal_id })}
      </label>
      <input
        id={props.reasonInputId}
        type="text"
        placeholder={props.controller.t("proposals:row.reasonPlaceholder")}
        aria-label={props.controller.t("proposals:row.reasonAria", { id: props.proposal.proposal_id })}
        value={props.controller.reasonByProposal[props.proposal.proposal_id] ?? ""}
        onChange={(event) => props.controller.setReasonByProposal((previous) => ({ ...previous, [props.proposal.proposal_id]: event.target.value }))}
        className="mb-3 w-full rounded border border-beige-300 bg-white px-3 py-2 font-mono text-sm"
      />
    </>
  );
}

function ProposalActions(props: {
  readonly busy: boolean;
  readonly canAccept: boolean;
  readonly proposalId: string;
  readonly submitReview: (proposalId: string, verdict: "accept" | "reject") => Promise<void>;
  readonly t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <div className="flex gap-2">
      <button type="button" disabled={props.busy || !props.canAccept} onClick={() => void props.submitReview(props.proposalId, "accept")} className="rounded bg-state-ok px-4 py-2 font-mono text-sm text-white disabled:opacity-50">
        {props.t("proposals:row.accept")}
      </button>
      <button type="button" disabled={props.busy} onClick={() => void props.submitReview(props.proposalId, "reject")} className="rounded bg-state-error px-4 py-2 font-mono text-sm text-white disabled:opacity-50">
        {props.t("proposals:row.reject")}
      </button>
    </div>
  );
}

async function fetchPendingProposals(workspaceId: string | null, signal: AbortSignal): Promise<readonly PendingSummary[]> {
  const envelope = await apiFetch<PendingEnvelope>(`/proposals/${workspaceId}/pending`, { signal });
  return envelope.data.proposals;
}

async function submitProposalReview(props: {
  readonly proposalId: string;
  readonly verdict: "accept" | "reject";
  readonly reviewer: string;
  readonly reasonByProposal: Record<string, string>;
  readonly refetch: (mode?: "replace" | "background") => Promise<readonly PendingSummary[] | null>;
  readonly setBusyProposalIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  readonly showToast: (input: Parameters<ReturnType<typeof useToasts>["showToast"]>[0]) => void;
  readonly t: ReturnType<typeof useI18n>["t"];
  readonly workspaceId: string | null;
}) {
  const trimmedReviewer = props.reviewer.trim();
  if (trimmedReviewer.length === 0) {
    props.showToast({ type: "error", message: props.t("proposals:reviewer.required") });
    return;
  }
  if (props.workspaceId === null) return;
  props.setBusyProposalIds((current) => new Set(current).add(props.proposalId));
  try {
    const envelope = await postReview(props, trimmedReviewer);
    props.showToast({ type: "success", message: reviewToastMessage(envelope, props.proposalId, props.verdict, props.t) });
    await props.refetch("replace");
  } catch (err) {
    if ((err as ApiError).status !== 401) {
      props.showToast({ type: "error", message: err instanceof Error ? err.message : props.t("proposals:toast.reviewFailed") });
    }
  } finally {
    props.setBusyProposalIds((current) => {
      const next = new Set(current);
      next.delete(props.proposalId);
      return next;
    });
  }
}

async function postReview(
  props: Pick<Parameters<typeof submitProposalReview>[0], "proposalId" | "reasonByProposal" | "verdict" | "workspaceId">,
  reviewerIdentity: string
): Promise<ReviewEnvelope> {
  return await apiFetch<ReviewEnvelope>(`/proposals/${props.workspaceId}/${props.proposalId}/review`, {
    method: "POST",
    body: {
      verdict: props.verdict,
      reason: props.reasonByProposal[props.proposalId] ?? null,
      reviewer_identity: reviewerIdentity
    }
  });
}

function reviewToastMessage(
  envelope: ReviewEnvelope,
  proposalId: string,
  verdict: "accept" | "reject",
  t: ReturnType<typeof useI18n>["t"]
): string {
  const stateKey = envelope.data?.resolution_state ?? verdict;
  const stateLabel = RESOLUTION_STATE_KEYS[stateKey] ? t(RESOLUTION_STATE_KEYS[stateKey]!) : stateKey;
  return t("proposals:toast.reviewed", { id: proposalId, state: stateLabel });
}

function focusHighlightedProposal(
  highlightedProposalId: string | null,
  highlightedRowRef: React.RefObject<HTMLLIElement>
) {
  if (highlightedProposalId === null || highlightedRowRef.current === null) return;
  highlightedRowRef.current.scrollIntoView?.({ block: "center" });
  highlightedRowRef.current.focus({ preventScroll: true });
}

function formatProposedChanges(changes: Record<string, unknown> | null): string | null {
  if (changes === null) return null;
  return JSON.stringify(changes, null, 2);
}
