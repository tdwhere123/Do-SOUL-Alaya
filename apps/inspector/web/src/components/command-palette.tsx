import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  type SetStateAction
} from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { useI18n } from "../i18n/locale";
import type { DictKey } from "../i18n/dict";

// Inspector cmd-K palette: page jumps + read-only CLI verb reminders.
// invariant: the palette never invokes CLI actions directly; it only
// navigates within Inspector or copies a command for the operator's shell.

interface PaletteItem {
  readonly id: string;
  readonly kind: "page" | "verb";
  readonly title: string;
  readonly subtitle: string;
  readonly action: () => void;
}

type Translate = ReturnType<typeof useI18n>["t"];

interface PagePaletteItem {
  readonly id: string;
  readonly kind: "page";
  readonly titleKey: DictKey;
  readonly subtitle: string;
  readonly to: string;
}

interface VerbPaletteItem {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly hintKey: DictKey;
}

const PAGE_ITEMS: ReadonlyArray<PagePaletteItem> = [
  { id: "page-overview", kind: "page", titleKey: "nav:overview", subtitle: "/overview", to: "/overview" },
  { id: "page-governance", kind: "page", titleKey: "nav:governance", subtitle: "/governance", to: "/governance" },
  { id: "page-memory-browser", kind: "page", titleKey: "nav:browse", subtitle: "/memory-browser", to: "/memory-browser" },
  { id: "page-graph", kind: "page", titleKey: "nav:memoryGraph", subtitle: "/graph", to: "/graph" },
  { id: "page-system", kind: "page", titleKey: "nav:system", subtitle: "/system", to: "/system" },
  { id: "page-proposals", kind: "page", titleKey: "governance:tab.proposals", subtitle: "/governance?tab=proposals", to: "/governance?tab=proposals" },
  { id: "page-health-inbox", kind: "page", titleKey: "governance:tab.healthInbox", subtitle: "/governance?tab=health-inbox", to: "/governance?tab=health-inbox" },
  { id: "page-config", kind: "page", titleKey: "system:tab.config", subtitle: "/system?tab=config", to: "/system?tab=config" },
  { id: "page-recall", kind: "page", titleKey: "palette:page.recallStats", subtitle: "/recall", to: "/recall" },
  { id: "page-bench-trend", kind: "page", titleKey: "palette:page.benchTrend", subtitle: "/bench-trend", to: "/bench-trend" }
];

const VERB_ITEMS: ReadonlyArray<VerbPaletteItem> = [
  { id: "verb-attach", title: "alaya attach", command: "alaya attach", hintKey: "palette:verb.attachHint" },
  { id: "verb-detach", title: "alaya detach", command: "alaya detach", hintKey: "palette:verb.detachHint" },
  { id: "verb-status", title: "alaya status", command: "alaya status", hintKey: "palette:verb.statusHint" },
  { id: "verb-inspect", title: "alaya inspect", command: "alaya inspect", hintKey: "palette:verb.inspectHint" },
  { id: "verb-review", title: "alaya review pending", command: "alaya review pending", hintKey: "palette:verb.reviewHint" }
];

const PALETTE_KIND_KEYS: Record<PaletteItem["kind"], DictKey> = {
  page: "palette:kind.page",
  verb: "palette:kind.verb"
};

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  usePaletteOpenFocus(open, inputRef, setQuery, setActiveIndex);
  const items = usePaletteItems(query, navigate, onClose, t);
  const handleKeyDown = usePaletteKeyboard(items, activeIndex, setActiveIndex, onClose);

  if (!open) return null;
  return (
    <CommandPaletteDialog label={t("palette:dialogLabel")} onClose={onClose}>
      <PaletteInput
        inputRef={inputRef}
        placeholder={t("palette:placeholder")}
        query={query}
        setActiveIndex={setActiveIndex}
        setQuery={setQuery}
        onKeyDown={handleKeyDown}
      />
      <PaletteResults
        activeIndex={activeIndex}
        items={items}
        setActiveIndex={setActiveIndex}
        t={t}
      />
    </CommandPaletteDialog>
  );
}

function usePaletteOpenFocus(
  open: boolean,
  inputRef: RefObject<HTMLInputElement | null>,
  setQuery: (query: string) => void,
  setActiveIndex: (index: number) => void
) {
  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    setActiveIndex(0);
    const handle = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(handle);
  }, [inputRef, open, setActiveIndex, setQuery]);
}

function usePaletteItems(query: string, navigate: NavigateFunction, onClose: () => void, t: Translate) {
  return useMemo(() => {
    const all = [
      ...PAGE_ITEMS.map((item) => pagePaletteItem(item, navigate, onClose, t)),
      ...VERB_ITEMS.map((item) => verbPaletteItem(item, onClose, t))
    ];
    return filterPaletteItems(all, query);
  }, [navigate, onClose, query, t]);
}

function usePaletteKeyboard(
  items: ReadonlyArray<PaletteItem>,
  activeIndex: number,
  setActiveIndex: Dispatch<SetStateAction<number>>,
  onClose: () => void
) {
  return useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => nextPaletteIndex(prev + 1, items.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => nextPaletteIndex(prev - 1, items.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      items[activeIndex]?.action();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }, [activeIndex, items, onClose, setActiveIndex]);
}

function CommandPaletteDialog(props: { readonly children: ReactNode; readonly label: string; readonly onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={props.label} className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-32" onClick={props.onClose}>
      <div className="w-full max-w-lg bg-beige-50 border border-beige-300 shadow-xl" onClick={(event) => event.stopPropagation()}>
        {props.children}
      </div>
    </div>
  );
}

function PaletteInput(props: {
  readonly inputRef: Ref<HTMLInputElement>;
  readonly placeholder: string;
  readonly query: string;
  readonly setActiveIndex: (index: number) => void;
  readonly setQuery: (query: string) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      ref={props.inputRef}
      type="text"
      value={props.query}
      onChange={(event) => {
        props.setQuery(event.target.value);
        props.setActiveIndex(0);
      }}
      onKeyDown={props.onKeyDown}
      placeholder={props.placeholder}
      className="w-full px-4 py-3 text-sm font-mono bg-transparent border-b border-beige-300 focus:outline-none"
    />
  );
}

function PaletteResults(props: {
  readonly activeIndex: number;
  readonly items: ReadonlyArray<PaletteItem>;
  readonly setActiveIndex: (index: number) => void;
  readonly t: Translate;
}) {
  return (
    <ul className="max-h-80 overflow-auto">
      {props.items.length === 0 ? (
        <li className="px-4 py-3 text-xs font-mono text-ink-500">{props.t("palette:empty")}</li>
      ) : (
        props.items.map((item, index) => (
          <PaletteResultRow key={item.id} active={index === props.activeIndex} index={index} item={item} setActiveIndex={props.setActiveIndex} t={props.t} />
        ))
      )}
    </ul>
  );
}

function PaletteResultRow(props: {
  readonly active: boolean;
  readonly index: number;
  readonly item: PaletteItem;
  readonly setActiveIndex: (index: number) => void;
  readonly t: Translate;
}) {
  return (
    <li onMouseEnter={() => props.setActiveIndex(props.index)} onMouseDown={(event) => activatePaletteMouse(event, props.item)} className={`px-4 py-2 cursor-pointer font-mono text-sm ${props.active ? "bg-beige-200" : ""}`}>
      <div className="flex items-center justify-between">
        <span>{props.item.title}</span>
        <span className="text-[10px] uppercase tracking-widest text-ink-500">{props.t(PALETTE_KIND_KEYS[props.item.kind])}</span>
      </div>
      <div className="text-[11px] text-ink-500">{props.item.subtitle}</div>
    </li>
  );
}

function pagePaletteItem(
  item: PagePaletteItem,
  navigate: NavigateFunction,
  onClose: () => void,
  t: Translate
): PaletteItem {
  return { id: item.id, kind: item.kind, title: t(item.titleKey), subtitle: item.subtitle, action: () => { navigate(item.to); onClose(); } };
}

function verbPaletteItem(
  item: VerbPaletteItem,
  onClose: () => void,
  t: Translate
): PaletteItem {
  return { id: item.id, kind: "verb", title: item.title, subtitle: t(item.hintKey), action: () => copyVerb(item.command, onClose) };
}

function filterPaletteItems(items: ReadonlyArray<PaletteItem>, query: string): ReadonlyArray<PaletteItem> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter((item) => item.title.toLowerCase().includes(needle) || item.subtitle.toLowerCase().includes(needle));
}

function activatePaletteMouse(event: ReactMouseEvent, item: PaletteItem) {
  event.preventDefault();
  item.action();
}

function copyVerb(command: string, onClose: () => void) {
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(command);
  onClose();
}

function nextPaletteIndex(index: number, itemCount: number): number {
  if (itemCount === 0) return 0;
  return Math.min(Math.max(index, 0), itemCount - 1);
}

export function useCommandPaletteHotkey(open: boolean, toggle: () => void): void {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const isPaletteKey = event.key === "k" && (event.metaKey || event.ctrlKey);
      if (isPaletteKey) {
        event.preventDefault();
        toggle();
      } else if (event.key === "Escape" && open) {
        toggle();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, toggle]);
}
