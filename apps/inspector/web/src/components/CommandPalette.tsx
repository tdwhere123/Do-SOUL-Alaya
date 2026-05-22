import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

// Inspector cmd-K palette: page jumps + read-only CLI verb reminders.
// Inspector is a tooling loopback per invariants §21a, so the palette
// must not invoke attach/detach/status/inspect/review directly. It
// renders the CLI verb plus a copy-to-clipboard shortcut so the
// operator runs them in their own shell, matching how the docs treat
// these verbs.

interface PaletteItem {
  readonly id: string;
  readonly kind: "page" | "verb";
  readonly title: string;
  readonly subtitle: string;
  readonly action: () => void;
}

const PAGE_ITEMS: ReadonlyArray<Omit<PaletteItem, "action"> & { readonly to: string }> = [
  { id: "page-overview", kind: "page", title: "Overview", subtitle: "/overview", to: "/overview" },
  { id: "page-bench-trend", kind: "page", title: "Bench Trend", subtitle: "/bench-trend", to: "/bench-trend" },
  { id: "page-graph", kind: "page", title: "Memory Graph", subtitle: "/graph", to: "/graph" },
  { id: "page-memory-browser", kind: "page", title: "Memory Browser", subtitle: "/memory-browser", to: "/memory-browser" },
  { id: "page-proposals", kind: "page", title: "Pending Proposals", subtitle: "/proposals", to: "/proposals" },
  { id: "page-recall", kind: "page", title: "Recall Stats", subtitle: "/recall", to: "/recall" },
  { id: "page-status", kind: "page", title: "System Status", subtitle: "/status", to: "/status" },
  { id: "page-config", kind: "page", title: "Configuration", subtitle: "/config", to: "/config" }
];

const VERB_ITEMS: ReadonlyArray<{ readonly id: string; readonly title: string; readonly command: string; readonly hint: string }> = [
  { id: "verb-attach", title: "alaya attach", command: "alaya attach", hint: "Attach a workspace + CLI agent target." },
  { id: "verb-detach", title: "alaya detach", command: "alaya detach", hint: "Detach the current attached agent." },
  { id: "verb-status", title: "alaya status", command: "alaya status", hint: "Print daemon + workspace status." },
  { id: "verb-inspect", title: "alaya inspect", command: "alaya inspect", hint: "Reopen this Inspector loopback with a fresh token." },
  { id: "verb-review", title: "alaya review pending", command: "alaya review pending", hint: "List pending governance proposals." }
];

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      const handle = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(handle);
    }
    return undefined;
  }, [open]);

  const items: ReadonlyArray<PaletteItem> = useMemo(() => {
    const pageItems = PAGE_ITEMS.map<PaletteItem>((item) => ({
      id: item.id,
      kind: "page",
      title: item.title,
      subtitle: item.subtitle,
      action: () => {
        navigate(item.to);
        onClose();
      }
    }));
    const verbItems = VERB_ITEMS.map<PaletteItem>((item) => ({
      id: item.id,
      kind: "verb",
      title: item.title,
      subtitle: item.hint,
      action: () => {
        const copy = navigator.clipboard?.writeText.bind(navigator.clipboard);
        if (copy !== undefined) {
          void copy(item.command);
        }
        onClose();
      }
    }));
    const all = [...pageItems, ...verbItems];
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.subtitle.toLowerCase().includes(needle)
    );
  }, [query, navigate, onClose]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, items.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        items[activeIndex]?.action();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [items, activeIndex, onClose]
  );

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-32"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-beige-50 border border-beige-300 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Jump to page or copy CLI verb..."
          className="w-full px-4 py-3 text-sm font-mono bg-transparent border-b border-beige-300 focus:outline-none"
        />
        <ul className="max-h-80 overflow-auto">
          {items.length === 0 ? (
            <li className="px-4 py-3 text-xs font-mono text-ink-500">No matches</li>
          ) : (
            items.map((item, index) => (
              <li
                key={item.id}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  item.action();
                }}
                className={`px-4 py-2 cursor-pointer font-mono text-sm ${
                  index === activeIndex ? "bg-beige-200" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span>{item.title}</span>
                  <span className="text-[10px] uppercase tracking-widest text-ink-500">
                    {item.kind}
                  </span>
                </div>
                <div className="text-[11px] text-ink-500">{item.subtitle}</div>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

export function useCommandPaletteHotkey(open: boolean, toggle: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
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
