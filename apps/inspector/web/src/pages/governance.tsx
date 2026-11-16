import { useSearchParams } from "react-router-dom";
import { CheckSquare, HeartPulse } from "lucide-react";
import ProposalsPage from "./proposals";
import HealthInboxPage from "./health-inbox";
import { PageTabs } from "../components/page-tabs";
import type { DictKey } from "../i18n/dict";

// invariant: Governance is the operator-decisions surface merging the
// pending-proposals queue and the health inbox. It adds no agent control
// flow — both children proxy writes through the governed daemon
// proposal/review endpoints (see apps/inspector/src/routes/proposals.ts).

type GovernanceTab = "proposals" | "health-inbox";

const TABS: ReadonlyArray<{
  readonly id: GovernanceTab;
  readonly labelKey: DictKey;
  readonly Icon: typeof CheckSquare;
}> = [
  { id: "proposals", labelKey: "governance:tab.proposals", Icon: CheckSquare },
  { id: "health-inbox", labelKey: "governance:tab.healthInbox", Icon: HeartPulse }
];

function resolveTab(raw: string | null): GovernanceTab {
  return raw === "health-inbox" ? "health-inbox" : "proposals";
}

export default function GovernancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get("tab"));

  const selectTab = (tab: GovernanceTab) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", tab);
        return next;
      },
      { replace: true }
    );
  };

  return (
    <div className="flex flex-col h-full">
      <PageTabs
        tabs={TABS}
        activeTab={activeTab}
        onSelect={selectTab}
        labelKey="nav:governance"
        testIdPrefix="governance"
      />
      <div className="flex-1 min-h-0">
        {activeTab === "proposals" ? <ProposalsPage /> : <HealthInboxPage />}
      </div>
    </div>
  );
}
