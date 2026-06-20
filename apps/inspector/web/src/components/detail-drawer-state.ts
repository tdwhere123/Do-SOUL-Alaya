import { useCallback, useEffect, useMemo, useState } from "react";
import type { GraphNode } from "../types/graph";
import { NODE_COLOR } from "../utils/graph";

export type DrawerProposalAction = "keep" | "rewrite" | "downgrade" | "retire";

export interface DetailDrawerState {
  readonly busyAction: string | null;
  readonly canAct: boolean;
  readonly cliCommand: string;
  readonly hasEvidence: boolean;
  readonly hasRemembered: boolean;
  readonly hasTrust: boolean;
  readonly hasUsage: boolean;
  readonly kindColor: string;
  readonly rewriteContent: string;
  readonly targetId: string;
  readonly runAction: (action: DrawerProposalAction, newContent?: string) => Promise<void>;
  readonly setRewriteContent: (value: string) => void;
}

interface UseDetailDrawerStateOptions {
  readonly node: GraphNode | null;
  readonly onCreateProposal: (
    action: DrawerProposalAction,
    nodeId: string,
    newContent?: string
  ) => Promise<void>;
}

export function useDetailDrawerState(props: UseDetailDrawerStateOptions): DetailDrawerState {
  const { node } = props;
  const [rewriteContent, setRewriteContent] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const targetId = node ? node.object_id ?? node.id : "";

  useEffect(() => {
    setRewriteContent(node?.summary ?? node?.label ?? "");
    setBusyAction(null);
  }, [node]);

  const runAction = useCallback(
    async (action: DrawerProposalAction, newContent?: string) => {
      if (!node || busyAction !== null) return;
      setBusyAction(action);
      try {
        await props.onCreateProposal(action, targetId, newContent);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, node, props, targetId]
  );

  return useMemo(
    () => ({
      busyAction,
      canAct: node?.kind === "memory",
      cliCommand: node ? `alaya tools call --json soul.open_pointer '{"pointer_id":"${targetId}"}'` : "",
      hasEvidence: Boolean(node?.evidence_refs && node.evidence_refs.length > 0),
      hasRemembered: Boolean(node?.summary || node?.rationale),
      hasTrust: node?.confidence !== undefined,
      hasUsage:
        node?.last_used_at !== undefined ||
        node?.last_hit_at !== undefined ||
        node?.influence_count !== undefined,
      kindColor: node ? NODE_COLOR[node.kind] ?? "#586E75" : "#586E75",
      rewriteContent,
      runAction,
      setRewriteContent,
      targetId
    }),
    [busyAction, node, rewriteContent, runAction, targetId]
  );
}
