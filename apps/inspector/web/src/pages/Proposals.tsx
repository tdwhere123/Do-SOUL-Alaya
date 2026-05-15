import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";
import { useI18n } from "../i18n/Locale";
import type { DictKey } from "../i18n/dict";

// A1 (HITL daemon backbone) — minimal Pending Proposals view. The
// Inspector is a memory-tooling loopback, not an agent surface, so the
// page intentionally only shows the queue and exposes accept/reject.
// Both calls go through the daemon HTTP wrapper around the new MCP
// tools (soul.list_pending_proposals + soul.review_memory_proposal).

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

export default function ProposalsPage() {
  const { t } = useI18n();
  const [proposals, setProposals] = useState<readonly PendingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState<string>("");
  const [reasonByProposal, setReasonByProposal] = useState<Record<string, string>>({});
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const highlightedRowRef = useRef<HTMLLIElement | null>(null);
  const { showToast } = useToasts();
  const highlightedProposalId = searchParams.get("highlight");

  const refresh = useCallback(async () => {
    const workspaceId = getWorkspaceId();
    if (workspaceId === null) {
      setError(t("proposals:loadFailedNoWorkspace"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const envelope = await apiFetch<PendingEnvelope>(
        `/proposals/${workspaceId}/pending`
      );
      setProposals(envelope.data.proposals);
    } catch (err) {
      if ((err as ApiError).status === 401) {
        return;
      }
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      const workspaceId = getWorkspaceId();
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
        await refresh();
      } catch (err) {
        if ((err as ApiError).status === 401) {
          return;
        }
        showToast({
          type: "error",
          message: err instanceof Error ? err.message : t("proposals:toast.reviewFailed")
        });
      } finally {
        setBusyProposalId(null);
      }
    },
    [reasonByProposal, refresh, reviewer, showToast, t]
  );

  return (
    <div className="h-full w-full overflow-y-auto"><div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-ink-600 mb-4 font-mono uppercase tracking-widest">
        {t("proposals:title")}
      </h1>
      <div className="mb-6">
        <label
          htmlFor="proposal-reviewer-identity"
          className="block text-sm font-mono text-ink-700 mb-1"
        >
          {t("proposals:reviewer.label")}
        </label>
        <input
          id="proposal-reviewer-identity"
          type="text"
          value={reviewer}
          onChange={(event) => setReviewer(event.target.value)}
          placeholder={t("proposals:reviewer.placeholder")}
          className="w-full px-3 py-2 border border-beige-300 rounded font-mono text-sm bg-beige-100"
        />
      </div>
      {loading && (
        <p className="text-ink-600 font-mono text-sm">{t("proposals:loading")}</p>
      )}
      {error !== null && (
        <p className="text-red-700 font-mono text-sm">
          {t("proposals:errorPrefix", { message: error })}
        </p>
      )}
      {!loading && proposals.length === 0 && (
        <p className="text-ink-700 font-mono text-sm">{t("proposals:empty")}</p>
      )}
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
                ? "border-2 border-state-emphasis rounded p-4 bg-beige-100"
                : "border border-beige-300 rounded p-4 bg-beige-100"
            }
          >
            <div className="font-mono text-xs text-ink-500 mb-2">
              {proposal.proposal_id}
            </div>
            <div className="font-mono text-sm text-ink-600 mb-2">
              {proposal.target_object_kind} {t("proposals:row.targetSeparator")} {proposal.target_object_id}
            </div>
            <div className="text-sm text-ink-700 mb-3">
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
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink-600">
                  {proposedChangesDisplay}
                </pre>
              )}
            </div>
            <div className="text-xs text-ink-500 mb-3 font-mono">
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
                setReasonByProposal((prev) => ({
                  ...prev,
                  [proposal.proposal_id]: event.target.value
                }))
              }
              className="w-full px-3 py-2 border border-beige-300 rounded font-mono text-sm bg-white mb-3"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busyProposalId === proposal.proposal_id || !canAccept}
                onClick={() => void submitReview(proposal.proposal_id, "accept")}
                className="px-4 py-2 bg-state-ok text-white font-mono text-sm rounded disabled:opacity-50"
              >
                {t("proposals:row.accept")}
              </button>
              <button
                type="button"
                disabled={busyProposalId === proposal.proposal_id}
                onClick={() => void submitReview(proposal.proposal_id, "reject")}
                className="px-4 py-2 bg-state-error text-white font-mono text-sm rounded disabled:opacity-50"
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
