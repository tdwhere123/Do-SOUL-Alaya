import { useSearchParams } from "react-router-dom";
import { CheckSquare, HeartPulse } from "lucide-react";
import ProposalsPage from "./proposals";
import HealthInboxPage from "./health-inbox";
import { useI18n } from "../i18n/locale";
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
  const { t } = useI18n();
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
      <nav
        data-testid="governance-tabs"
        className="flex gap-1 px-6 pt-4 border-b border-beige-300 bg-beige-50"
        role="tablist"
        aria-label={t("nav:governance")}
      >
        {TABS.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            data-testid={`governance-tab-${id}`}
            onClick={() => selectTab(id)}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-widest border-b-2 transition-colors ${
              activeTab === id
                ? "border-ink-600 text-ink-700"
                : "border-transparent text-ink-700/50 hover:text-ink-700"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {t(labelKey)}
          </button>
        ))}
      </nav>
      <div className="flex-1 min-h-0">
        {activeTab === "proposals" ? <ProposalsPage /> : <HealthInboxPage />}
      </div>
    </div>
  );
}
