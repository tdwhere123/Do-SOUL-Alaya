import { useCallback, useEffect, useState } from "react";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";

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

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<readonly PendingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState<string>("");
  const [reasonByProposal, setReasonByProposal] = useState<Record<string, string>>({});
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const { showToast } = useToasts();

  const refresh = useCallback(async () => {
    const workspaceId = getWorkspaceId();
    if (workspaceId === null) {
      setError("No workspaceId in URL. Re-run `alaya inspect` with --workspace.");
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
        throw err;
      }
      setError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitReview = useCallback(
    async (proposalId: string, verdict: "accept" | "reject") => {
      const trimmedReviewer = reviewer.trim();
      if (trimmedReviewer.length === 0) {
        showToast({ kind: "error", message: "Reviewer identity is required." });
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
        showToast({
          kind: "success",
          message: `Proposal ${proposalId} ${envelope.data?.resolution_state ?? verdict}.`
        });
        await refresh();
      } catch (err) {
        if ((err as ApiError).status === 401) {
          throw err;
        }
        showToast({
          kind: "error",
          message: err instanceof Error ? err.message : "review failed"
        });
      } finally {
        setBusyProposalId(null);
      }
    },
    [reasonByProposal, refresh, reviewer, showToast]
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-[#586E75] mb-4 font-mono uppercase tracking-widest">
        Pending Proposals
      </h1>
      <div className="mb-6">
        <label className="block text-sm font-mono text-[#657B83] mb-1">
          Reviewer identity (required for accept/reject)
        </label>
        <input
          type="text"
          value={reviewer}
          onChange={(event) => setReviewer(event.target.value)}
          placeholder="user:alice"
          className="w-full px-3 py-2 border border-[#D4CDB8] rounded font-mono text-sm bg-[#FDF6E3]"
        />
      </div>
      {loading && (
        <p className="text-[#586E75] font-mono text-sm">Loading proposals...</p>
      )}
      {error !== null && (
        <p className="text-red-700 font-mono text-sm">Error: {error}</p>
      )}
      {!loading && proposals.length === 0 && (
        <p className="text-[#657B83] font-mono text-sm">No pending proposals.</p>
      )}
      <ul className="space-y-4">
        {proposals.map((proposal) => (
          <li
            key={proposal.proposal_id}
            className="border border-[#D4CDB8] rounded p-4 bg-[#FDF6E3]"
          >
            <div className="font-mono text-xs text-[#93A1A1] mb-2">
              {proposal.proposal_id}
            </div>
            <div className="font-mono text-sm text-[#586E75] mb-2">
              {proposal.target_object_kind} → {proposal.target_object_id}
            </div>
            <div className="text-sm text-[#657B83] mb-3">
              {proposal.proposed_change_summary}
            </div>
            <div className="text-xs text-[#93A1A1] mb-3 font-mono">
              created_at: {proposal.created_at}
            </div>
            <input
              type="text"
              placeholder="optional review reason"
              value={reasonByProposal[proposal.proposal_id] ?? ""}
              onChange={(event) =>
                setReasonByProposal((prev) => ({
                  ...prev,
                  [proposal.proposal_id]: event.target.value
                }))
              }
              className="w-full px-3 py-2 border border-[#D4CDB8] rounded font-mono text-sm bg-white mb-3"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busyProposalId === proposal.proposal_id}
                onClick={() => void submitReview(proposal.proposal_id, "accept")}
                className="px-4 py-2 bg-[#859900] text-white font-mono text-sm rounded disabled:opacity-50"
              >
                Accept
              </button>
              <button
                type="button"
                disabled={busyProposalId === proposal.proposal_id}
                onClick={() => void submitReview(proposal.proposal_id, "reject")}
                className="px-4 py-2 bg-[#DC322F] text-white font-mono text-sm rounded disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
