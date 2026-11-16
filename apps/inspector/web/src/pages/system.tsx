import { useSearchParams } from "react-router-dom";
import { Activity, Cpu } from "lucide-react";
import StatusPage from "./status";
import ConfigPage from "./config";
import { PageTabs } from "../components/page-tabs";
import type { DictKey } from "../i18n/dict";

// invariant: System merges read-only daemon status with the configuration
// surface. Config writes still proxy to the daemon config endpoints; the
// Inspector remains a memory-tooling loopback, not an agent surface.

type SystemTab = "status" | "config";

const TABS: ReadonlyArray<{
  readonly id: SystemTab;
  readonly labelKey: DictKey;
  readonly Icon: typeof Activity;
}> = [
  { id: "status", labelKey: "system:tab.status", Icon: Activity },
  { id: "config", labelKey: "system:tab.config", Icon: Cpu }
];

function resolveTab(raw: string | null): SystemTab {
  return raw === "config" ? "config" : "status";
}

export default function SystemPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get("tab"));

  const selectTab = (tab: SystemTab) => {
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
        labelKey="nav:system"
        testIdPrefix="system"
      />
      <div className="flex-1 min-h-0">
        {activeTab === "status" ? <StatusPage /> : <ConfigPage />}
      </div>
    </div>
  );
}
