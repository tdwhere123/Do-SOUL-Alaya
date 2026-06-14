import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useApiQuery } from "../hooks/useApiQuery";
import { useToasts } from "../components/Toast";
import { useI18n } from "../i18n/Locale";
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
  readonly data: {
    readonly proposals: readonly PendingSummary[];
    readonly total_count: number;
  };
}

interface ReviewEnvelope {
  readonly success: boolean;
  readonly data?: {
    readonly proposal_id: string;
    readonly resolution_state: string;
  };
}

const RESOLUTION_STATE_KEYS: Readonly<Record<string, DictKey>> = {
  accepted: "proposals:status.accepted",
  rejected: "proposals:status.rejected",
  pending: "proposals:status.pending"
};

/**
 * ProposalsPage is the inspector-side review queue for pending governance
 * proposals, including inline reviewer identity and accept/reject actions.
 */
export default function ProposalsPage() {
  const { t } = useI18n();
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId();
  const [reviewer, setReviewer] = useState("");
  const [reasonByProposal, setReasonByProposal] = useState<Record<string, string>>({});
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const highlightedRowRef = useRef<HTMLLIElement | null>(null);
  const highlightedProposalId = searchParams.get("highlight");

  const fetchProposals = useCallback(async (signal: AbortSignal) => {
    const envelope = await apiFetch<PendingEnvelope>(`/proposals/${workspaceId}/pending`, {
      signal
    });
    return envelope.data.proposals;
  }, [workspaceId]);

  const { data: proposalsData, error, loading, refetch } = useApiQuery(fetchProposals, [workspaceId], {
    enabled: workspaceId !== null
  });
  const proposals = proposalsData ?? [];

  useEffect(() => {
    if (highlightedProposalId === null || highlightedRowRef.current === null) {
      return;
    }
    highlightedRowRef.current.scrollIntoView?.({ block: "center" });
    highlightedRowRef.current.focus({ preventScroll: true });
  }, [highlightedProposalId, proposals]);

  const submitReview = useCallback(
    async (proposalId: string, verdict: "accept" | "reject") => {
      const trimmedReviewer = reviewer.trim();
      if (trimmedReviewer.length === 0) {
        showToast({ type: "error", message: t("proposals:reviewer.required") });
        return;
      }
      if (workspaceId === null) return;

      setBusyProposalId(proposalId);
      try {
        const envelope = await apiFetch<ReviewEnvelope>(
          `/proposals/${workspaceId}/${proposalId}/review`,
          {
            method: "POST",
            body: {
              verdict,
              reason: reasonByProposal[proposalId] ?? null,
              reviewer_identity: trimmedReviewer
            }
          }
        );
        const stateKey = envelope.data?.resolution_state ?? verdict;
        const stateLabel = RESOLUTION_STATE_KEYS[stateKey]
          ? t(RESOLUTION_STATE_KEYS[stateKey]!)
          : stateKey;
        showToast({
          type: "success",
          message: t("proposals:toast.reviewed", { id: proposalId, state: stateLabel })
        });
        await refetch("replace");
      } catch (err) {
        if ((err as ApiError).status === 401) return;
        showToast({
          type: "error",
          message: err instanceof Error ? err.message : t("proposals:toast.reviewFailed")
        });
      } finally {
        setBusyProposalId(null);
      }
    },
    [reasonByProposal, refetch, reviewer, showToast, t, workspaceId]
  );

  const loadError =
    workspaceId === null ? t("proposals:loadFailedNoWorkspace") : error;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-6">
        <h1 className="mb-4 font-mono text-2xl font-bold uppercase tracking-widest text-ink-600">
          {t("proposals:title")}
        </h1>

        <div className="mb-6">
          <label
            htmlFor="proposal-reviewer-identity"
            className="mb-1 block font-mono text-sm text-ink-700"
          >
            {t("proposals:reviewer.label")}
          </label>
          <input
            id="proposal-reviewer-identity"
            type="text"
            value={reviewer}
            onChange={(event) => setReviewer(event.target.value)}
            placeholder={t("proposals:reviewer.placeholder")}
            className="w-full rounded border border-beige-300 bg-beige-100 px-3 py-2 font-mono text-sm"
          />
        </div>

        {loading ? <p className="font-mono text-sm text-ink-600">{t("proposals:loading")}</p> : null}
        {loadError !== null ? (
          <p className="font-mono text-sm text-red-700">
            {t("proposals:errorPrefix", { message: loadError })}
          </p>
        ) : null}
        {!loading && proposals.length === 0 ? (
          <p className="font-mono text-sm text-ink-700">{t("proposals:empty")}</p>
        ) : null}

        <ul className="space-y-4">
          {proposals.map((proposal) => {
            const isHighlighted = proposal.proposal_id === highlightedProposalId;
            const proposedChangesDisplay = formatProposedChanges(proposal.proposed_changes);
            const canAccept = proposedChangesDisplay !== null;
            const reasonInputId = `review-reason-${proposal.proposal_id}`;

            return (
              <li
                key={proposal.proposal_id}
                ref={isHighlighted ? highlightedRowRef : undefined}
                tabIndex={isHighlighted ? -1 : undefined}
                aria-current={isHighlighted ? "true" : undefined}
                className={
                  isHighlighted
                    ? "rounded border-2 border-state-emphasis bg-beige-100 p-4"
                    : "rounded border border-beige-300 bg-beige-100 p-4"
                }
              >
                <div className="mb-2 font-mono text-xs text-ink-500">{proposal.proposal_id}</div>
                <div className="mb-2 font-mono text-sm text-ink-600">
                  {proposal.target_object_kind} {t("proposals:row.targetSeparator")}{" "}
                  {proposal.target_object_id}
                </div>
                <div className="mb-3 text-sm text-ink-700">
                  {proposal.proposed_change_summary}
                </div>
                <div className="mb-3 rounded border border-beige-300 bg-white p-3">
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-500">
                    {t("proposals:row.proposedChanges")}
                  </div>
                  {proposedChangesDisplay === null ? (
                    <p className="font-mono text-xs text-red-700">
                      {t("proposals:row.proposedChangesUnavailable")}
                    </p>
                  ) : (
                    <pre className="max-h-56 overflow-auto break-words whitespace-pre-wrap font-mono text-xs text-ink-600">
                      {proposedChangesDisplay}
                    </pre>
                  )}
                </div>
                <div className="mb-3 font-mono text-xs text-ink-500">
                  {t("proposals:row.createdAt", { ts: proposal.created_at })}
                </div>
                <label htmlFor={reasonInputId} className="sr-only">
                  {t("proposals:row.reasonAria", { id: proposal.proposal_id })}
                </label>
                <input
                  id={reasonInputId}
                  type="text"
                  placeholder={t("proposals:row.reasonPlaceholder")}
                  aria-label={t("proposals:row.reasonAria", { id: proposal.proposal_id })}
                  value={reasonByProposal[proposal.proposal_id] ?? ""}
                  onChange={(event) =>
                    setReasonByProposal((previous) => ({
                      ...previous,
                      [proposal.proposal_id]: event.target.value
                    }))
                  }
                  className="mb-3 w-full rounded border border-beige-300 bg-white px-3 py-2 font-mono text-sm"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busyProposalId === proposal.proposal_id || !canAccept}
                    onClick={() => void submitReview(proposal.proposal_id, "accept")}
                    className="rounded bg-state-ok px-4 py-2 font-mono text-sm text-white disabled:opacity-50"
                  >
                    {t("proposals:row.accept")}
                  </button>
                  <button
                    type="button"
                    disabled={busyProposalId === proposal.proposal_id}
                    onClick={() => void submitReview(proposal.proposal_id, "reject")}
                    className="rounded bg-state-error px-4 py-2 font-mono text-sm text-white disabled:opacity-50"
                  >
                    {t("proposals:row.reject")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function formatProposedChanges(changes: Record<string, unknown> | null): string | null {
  if (changes === null) {
    return null;
  }
  return JSON.stringify(changes, null, 2);
}
