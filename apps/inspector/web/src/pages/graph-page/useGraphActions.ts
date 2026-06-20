import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, type ApiError } from "../../api";
import type { ToastInput } from "../../components/Toast";
import { useI18n } from "../../i18n/Locale";

type ShowToast = (input: ToastInput) => void;
type Translate = ReturnType<typeof useI18n>["t"];

interface ProposalCreateEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly proposal_id: string;
    readonly status: "created" | "already_pending";
  };
}

export function useGraphActions(props: {
  readonly showToast: ShowToast;
  readonly workspaceId: string | null;
}) {
  const { showToast, workspaceId } = props;
  const { t } = useI18n();
  const navigate = useNavigate();
  const copyToClipboard = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text);
      showToast({ message: t("common:copied"), type: "success", duration: 2500 });
    },
    [showToast, t]
  );
  const createMemoryProposal = useCallback(
    async (action: "keep" | "rewrite" | "downgrade" | "retire", nodeId: string, newContent?: string) => {
      if (workspaceId === null) {
        showToast({ type: "error", message: t("drawer:action.noWorkspace") });
        return;
      }
      try {
        const envelope = await postMemoryProposal(workspaceId, action, nodeId, newContent);
        showProposalToast(envelope, navigate, showToast, t);
      } catch (err) {
        if ((err as ApiError).status !== 401) {
          showToast({
            type: "error",
            message: err instanceof Error ? err.message : t("drawer:action.proposalFailed")
          });
        }
      }
    },
    [navigate, showToast, t, workspaceId]
  );
  return { copyToClipboard, createMemoryProposal };
}

async function postMemoryProposal(
  workspaceId: string,
  action: "keep" | "rewrite" | "downgrade" | "retire",
  nodeId: string,
  newContent?: string
): Promise<ProposalCreateEnvelope> {
  return await apiFetch<ProposalCreateEnvelope>(`/proposals/${workspaceId}/memory/${nodeId}/${action}`, {
    method: "POST",
    body: action === "rewrite" ? { new_content: newContent ?? "" } : undefined
  });
}

function showProposalToast(
  envelope: ProposalCreateEnvelope,
  navigate: (path: string) => void,
  showToast: ShowToast,
  t: Translate
) {
  const proposalId = envelope.data.proposal_id;
  const alreadyPending = envelope.data.status === "already_pending";
  showToast({
    type: "success",
    message: alreadyPending ? t("drawer:action.proposalAlreadyPending") : t("drawer:action.proposalCreated"),
    action: {
      label: t("drawer:action.proposalReviewLink"),
      onClick: () => navigate(`/proposals?highlight=${encodeURIComponent(proposalId)}`)
    }
  });
  navigate(`/proposals?highlight=${encodeURIComponent(proposalId)}`);
}
