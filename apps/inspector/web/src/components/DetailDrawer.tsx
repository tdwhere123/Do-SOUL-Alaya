import { Copy, Terminal, X } from "lucide-react";
import { clsx } from "clsx";
import type { GraphNode } from "../types/graph";
import { formatRelativeTime, NODE_COLOR } from "../utils/graph";

export interface DetailDrawerProps {
  readonly node: GraphNode | null;
  readonly onClose: () => void;
  readonly onFocusSubgraph: (id: string) => void;
  readonly onCopyCli: (text: string) => void;
}

export function DetailDrawer({ node, onClose, onFocusSubgraph, onCopyCli }: DetailDrawerProps) {
  const cliCommand = node
    ? `alaya tools call --json soul.open_pointer '{"pointer_id":"${node.id}"}'`
    : "";
  const kindColor = node ? NODE_COLOR[node.kind] ?? "#586E75" : "#586E75";

  return (
    <div
      className={clsx(
        "absolute right-0 top-0 h-full w-96 bg-beige-50 border-l border-beige-200 shadow-2xl transition-transform duration-300 transform",
        node ? "translate-x-0" : "translate-x-full"
      )}
      role="complementary"
      aria-label="Node details"
    >
      {node ? (
        <div className="relative h-full flex flex-col p-6 pl-7 font-mono overflow-y-auto">
          <div
            className="absolute left-0 top-0 bottom-0 w-1"
            style={{ backgroundColor: kindColor }}
            aria-hidden
          />

          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="px-2 py-0.5 text-[10px] uppercase tracking-widest rounded text-ink-700"
                style={{ backgroundColor: `${kindColor}33` }}
              >
                {node.kind}
              </span>
              {node.origin_plane === "global" ? (
                <span className="px-2 py-0.5 text-[10px] uppercase tracking-widest rounded bg-[#D4AF37]/20 text-[#7A5A0F]">
                  global
                </span>
              ) : null}
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-beige-200 rounded transition-colors -mr-1"
              aria-label="Close detail drawer"
            >
              <X className="w-5 h-5 text-ink-700/40" />
            </button>
          </div>

          <h2 className="text-lg font-bold text-ink-600 break-words leading-tight mb-5">
            {node.label}
          </h2>

          {node.summary ? (
            <section className="mb-6">
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                Summary
              </h4>
              <p className="text-sm text-ink-700 leading-relaxed whitespace-pre-wrap max-h-[36vh] overflow-y-auto pr-1">
                {node.summary}
              </p>
            </section>
          ) : null}

          <section className="mb-6">
            <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
              Metadata
            </h4>
            <dl className="bg-beige-100 p-3 rounded text-xs grid grid-cols-[5rem_1fr_auto] gap-x-3 gap-y-2 items-baseline">
              <dt className="text-ink-700/60">id</dt>
              <dd className="text-ink-700 break-all select-all">{node.id}</dd>
              <button
                onClick={() => onCopyCli(node.id)}
                className="text-ink-700/40 hover:text-ink-700"
                aria-label="Copy node id"
              >
                <Copy className="w-3 h-3" />
              </button>

              <dt className="text-ink-700/60">scope</dt>
              <dd className="text-ink-700 break-all col-span-2">
                {node.scope_id ?? <span className="text-ink-700/30">—</span>}
              </dd>

              <dt className="text-ink-700/60">workspace</dt>
              <dd className="text-ink-700 break-all col-span-2">
                {node.workspace_id ?? <span className="text-ink-700/30">—</span>}
              </dd>

              <dt className="text-ink-700/60">created</dt>
              <dd className="text-ink-700 col-span-2" title={node.created_at}>
                {node.created_at ? (
                  formatRelativeTime(node.created_at)
                ) : (
                  <span className="text-ink-700/30">—</span>
                )}
              </dd>

              <dt className="text-ink-700/60">degree</dt>
              <dd className="text-ink-700 col-span-2">
                {node.degree ?? 0}{" "}
                <span className="text-ink-700/40">
                  connection{node.degree === 1 ? "" : "s"}
                </span>
              </dd>
            </dl>
          </section>

          <section className="mb-6">
            <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
              Spotlight
            </h4>
            <button
              onClick={() => onFocusSubgraph(node.id)}
              className="text-xs font-mono text-ink-600 underline hover:text-ink-700"
            >
              Focus 1-hop subgraph around this node →
            </button>
          </section>

          <div className="mt-auto pt-6 border-t border-beige-200">
            <button
              onClick={() => onCopyCli(cliCommand)}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-ink-600 text-beige-50 rounded hover:bg-ink-700 transition-colors text-xs font-bold uppercase tracking-widest"
            >
              <Terminal className="w-4 h-4" />
              Open in CLI
              <Copy className="w-3 h-3 ml-auto opacity-60" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
