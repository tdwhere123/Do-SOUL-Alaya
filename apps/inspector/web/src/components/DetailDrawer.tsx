import type { GraphNode } from "../types/graph";
import { useI18n } from "../i18n/Locale";
import { useDetailDrawerState, type DrawerProposalAction } from "./detail-drawer-state";
import { DetailDrawerContent, DetailDrawerShell } from "./detail-drawer-sections";

export interface DetailDrawerProps {
  readonly node: GraphNode | null;
  readonly onClose: () => void;
  readonly onFocusSubgraph: (id: string) => void;
  readonly onCopyCli: (text: string) => void;
  readonly onCreateProposal: (
    action: DrawerProposalAction,
    nodeId: string,
    newContent?: string
  ) => Promise<void>;
}

export default function DetailDrawer(props: DetailDrawerProps) {
  const { t } = useI18n();
  const state = useDetailDrawerState({
    node: props.node,
    onCreateProposal: props.onCreateProposal
  });

  return (
    <DetailDrawerShell
      node={props.node}
      kindColor={state.kindColor}
      ariaLabel={t("drawer:nodeAriaLabel")}
    >
      {props.node ? (
        <DetailDrawerContent
          node={props.node}
          state={state}
          onClose={props.onClose}
          onCopyCli={props.onCopyCli}
          onFocusSubgraph={props.onFocusSubgraph}
        />
      ) : null}
    </DetailDrawerShell>
  );
}
