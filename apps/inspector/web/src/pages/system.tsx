import { useSearchParams } from "react-router-dom";
import { Activity, Cpu } from "lucide-react";
import StatusPage from "./status";
import ConfigPage from "./config";
import { useI18n } from "../i18n/locale";
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
  const { t } = useI18n();
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
      <nav
        data-testid="system-tabs"
        className="flex gap-1 px-6 pt-4 border-b border-beige-300 bg-beige-50"
        role="tablist"
        aria-label={t("nav:system")}
      >
        {TABS.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            data-testid={`system-tab-${id}`}
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
        {activeTab === "status" ? <StatusPage /> : <ConfigPage />}
      </div>
    </div>
  );
}
