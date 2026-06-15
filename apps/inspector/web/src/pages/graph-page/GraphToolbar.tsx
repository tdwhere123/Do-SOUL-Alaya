import type { RefObject } from "react";
import { Search, X } from "lucide-react";
import { useI18n } from "../../i18n/Locale";
import { ViewModeToggle } from "./support";
import type { ViewMode } from "./types";

interface GraphToolbarProps {
  readonly effectiveMode: ViewMode;
  readonly matchCount: number;
  readonly matchCursor: number;
  readonly onModeChange: (next: ViewMode) => void;
  readonly searchInputRef: RefObject<HTMLInputElement>;
  readonly searchTerm: string;
  readonly setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
  readonly spotlightActive: boolean;
  readonly webglSupported: boolean;
}

export default function GraphToolbar({
  effectiveMode,
  matchCount,
  matchCursor,
  onModeChange,
  searchInputRef,
  searchTerm,
  setSearchTerm,
  spotlightActive,
  webglSupported
}: GraphToolbarProps) {
  const { t } = useI18n();

  return (
    <div className="absolute left-4 right-4 top-4 z-20 flex items-center justify-between gap-3 sm:flex-row">
      <div className="flex flex-1 items-center gap-3 rounded-full border border-beige-200 bg-beige-50/95 px-4 py-2 shadow-sm backdrop-blur-sm sm:max-w-md">
        <Search className="w-3 h-3 text-ink-700/40" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder={t("graph:search.placeholder")}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-700 outline-none placeholder:text-ink-700/30"
          aria-label={t("graph:search.placeholder")}
        />
        {spotlightActive ? (
          <span className="text-[10px] text-ink-700/40 font-mono whitespace-nowrap">
            {matchCount === 0
              ? t("graph:search.noMatch")
              : t("graph:search.matchCounter", {
                  current: matchCursor + 1,
                  total: matchCount
                })}
          </span>
        ) : null}
        {searchTerm ? (
          <button
            type="button"
            onClick={() => setSearchTerm("")}
            className="text-ink-700/40 hover:text-ink-700"
            aria-label={t("graph:search.clear")}
          >
            <X className="w-3 h-3" />
          </button>
        ) : null}
      </div>

      <ViewModeToggle
        mode={effectiveMode}
        webglSupported={webglSupported}
        onChange={onModeChange}
      />
    </div>
  );
}
