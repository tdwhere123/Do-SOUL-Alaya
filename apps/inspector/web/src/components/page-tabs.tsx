import type { LucideIcon } from "lucide-react";
import { useI18n } from "../i18n/locale";
import type { DictKey } from "../i18n/dict";

export function PageTabs<T extends string>({
  tabs,
  activeTab,
  onSelect,
  labelKey,
  testIdPrefix
}: {
  readonly tabs: readonly {
    readonly id: T;
    readonly labelKey: DictKey;
    readonly Icon: LucideIcon;
  }[];
  readonly activeTab: T;
  readonly onSelect: (tab: T) => void;
  readonly labelKey: DictKey;
  readonly testIdPrefix: string;
}) {
  const { t } = useI18n();
  return (
    <nav
      data-testid={`${testIdPrefix}-tabs`}
      className="flex gap-1 px-6 pt-4 border-b border-beige-300 bg-beige-50"
      role="tablist"
      aria-label={t(labelKey)}
    >
      {tabs.map(({ id, labelKey: tabLabelKey, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={activeTab === id}
          data-testid={`${testIdPrefix}-tab-${id}`}
          onClick={() => onSelect(id)}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-widest border-b-2 transition-colors ${
            activeTab === id
              ? "border-ink-600 text-ink-700"
              : "border-transparent text-ink-700/50 hover:text-ink-700"
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          {t(tabLabelKey)}
        </button>
      ))}
    </nav>
  );
}
