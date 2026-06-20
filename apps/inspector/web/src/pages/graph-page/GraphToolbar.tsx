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
      <GraphSearchBox
        matchCount={matchCount}
        matchCursor={matchCursor}
        searchInputRef={searchInputRef}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        spotlightActive={spotlightActive}
      />
      <ViewModeToggle
        mode={effectiveMode}
        webglSupported={webglSupported}
        onChange={onModeChange}
      />
    </div>
  );
}

function GraphSearchBox(props: {
  readonly matchCount: number;
  readonly matchCursor: number;
  readonly searchInputRef: RefObject<HTMLInputElement>;
  readonly searchTerm: string;
  readonly setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
  readonly spotlightActive: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 items-center gap-3 rounded-full border border-beige-200 bg-beige-50/95 px-4 py-2 shadow-sm backdrop-blur-sm sm:max-w-md">
      <Search className="w-3 h-3 text-ink-700/40" />
      <SearchInput {...props} placeholder={t("graph:search.placeholder")} />
      <SearchMatchCounter {...props} />
      <ClearSearchButton searchTerm={props.searchTerm} setSearchTerm={props.setSearchTerm} />
    </div>
  );
}

function SearchInput(props: {
  readonly placeholder: string;
  readonly searchInputRef: RefObject<HTMLInputElement>;
  readonly searchTerm: string;
  readonly setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
}) {
  return (
    <input
      ref={props.searchInputRef}
      type="text"
      value={props.searchTerm}
      onChange={(event) => props.setSearchTerm(event.target.value)}
      placeholder={props.placeholder}
      className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-700 outline-none placeholder:text-ink-700/30"
      aria-label={props.placeholder}
    />
  );
}

function SearchMatchCounter(props: {
  readonly matchCount: number;
  readonly matchCursor: number;
  readonly spotlightActive: boolean;
}) {
  const { t } = useI18n();
  if (!props.spotlightActive) return null;
  return (
    <span className="text-[10px] text-ink-700/40 font-mono whitespace-nowrap">
      {props.matchCount === 0
        ? t("graph:search.noMatch")
        : t("graph:search.matchCounter", { current: props.matchCursor + 1, total: props.matchCount })}
    </span>
  );
}

function ClearSearchButton(props: {
  readonly searchTerm: string;
  readonly setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
}) {
  const { t } = useI18n();
  if (!props.searchTerm) return null;
  return (
    <button type="button" onClick={() => props.setSearchTerm("")} className="text-ink-700/40 hover:text-ink-700" aria-label={t("graph:search.clear")}>
      <X className="w-3 h-3" />
    </button>
  );
}
