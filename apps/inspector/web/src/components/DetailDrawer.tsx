import { useEffect, useState } from "react";
import { Check, Copy, Edit3, Terminal, Trash2, TrendingDown, X } from "lucide-react";
import { clsx } from "clsx";
import type { GraphNode } from "../types/graph";
import { formatRelativeTime, NODE_COLOR } from "../utils/graph";
import { useI18n } from "../i18n/Locale";
import type { DictKey } from "../i18n/dict";

// Translate origin_kind values into the legend's localized labels so the
// drawer header badge stays in sync with the in-graph legend.
const ORIGIN_KIND_LABEL_KEYS: Readonly<Record<string, DictKey>> = {
  user_memory: "graph:legend.user_memory",
  engineering_chunk: "graph:legend.engineering_chunk",
  reviewed_engineering_chunk: "graph:legend.reviewed_engineering_chunk",
  proposal_pending: "graph:legend.proposal_pending",
  system: "graph:legend.system"
};

export interface DetailDrawerProps {
  readonly node: GraphNode | null;
  readonly onClose: () => void;
  readonly onFocusSubgraph: (id: string) => void;
  readonly onCopyCli: (text: string) => void;
  readonly onCreateProposal: (
    action: "keep" | "rewrite" | "downgrade" | "retire",
    nodeId: string,
    newContent?: string
  ) => Promise<void>;
}

export default function DetailDrawer({
  node,
  onClose,
  onFocusSubgraph,
  onCopyCli,
  onCreateProposal
}: DetailDrawerProps) {
  const { t } = useI18n();
  const [rewriteContent, setRewriteContent] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // On the path plane node.id is a serialized PathAnchorRef; the memory object
  // id (node.object_id) is what open_pointer and the proposal flow address.
  // Fall back to node.id for any node without an object anchor.
  const targetId = node ? node.object_id ?? node.id : "";
  const cliCommand = node
    ? `alaya tools call --json soul.open_pointer '{"pointer_id":"${targetId}"}'`
    : "";
  const kindColor = node ? NODE_COLOR[node.kind] ?? "#586E75" : "#586E75";
  const hasRemembered = Boolean(node?.summary || node?.rationale);
  const hasEvidence = Boolean(node?.evidence_refs && node.evidence_refs.length > 0);
  const hasTrust = node?.confidence !== undefined;
  const hasUsage =
    node?.last_used_at !== undefined ||
    node?.last_hit_at !== undefined ||
    node?.influence_count !== undefined;
  const canAct = node?.kind === "memory";

  useEffect(() => {
    setRewriteContent(node?.summary ?? node?.label ?? "");
    setBusyAction(null);
  }, [node]);

  const runAction = async (
    action: "keep" | "rewrite" | "downgrade" | "retire",
    newContent?: string
  ) => {
    if (!node || busyAction !== null) return;
    setBusyAction(action);
    try {
      await onCreateProposal(action, targetId, newContent);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      className={clsx(
        "absolute right-0 top-0 h-full w-full max-w-[24rem] bg-beige-50 border-l border-beige-200 shadow-2xl transition-transform duration-300 transform sm:w-96",
        node ? "translate-x-0" : "translate-x-full"
      )}
      role="complementary"
      aria-label={t("drawer:nodeAriaLabel")}
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
              {node.origin_kind ? (
                <span className="px-2 py-0.5 text-[10px] uppercase tracking-widest rounded bg-ink-600/10 text-ink-700">
                  {ORIGIN_KIND_LABEL_KEYS[node.origin_kind]
                    ? t(ORIGIN_KIND_LABEL_KEYS[node.origin_kind]!)
                    : node.origin_kind.replace(/_/g, " ")}
                </span>
              ) : null}
              <span
                className="px-2 py-0.5 text-[10px] uppercase tracking-widest rounded text-ink-700"
                style={{ backgroundColor: `${kindColor}33` }}
              >
                {node.kind}
              </span>
              {node.origin_plane === "global" ? (
                <span className="px-2 py-0.5 text-[10px] uppercase tracking-widest rounded bg-state-warning/20 text-state-emphasis-text">
                  {t("drawer:globalBadge")}
                </span>
              ) : null}
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-beige-200 rounded transition-colors -mr-1"
              aria-label={t("drawer:close")}
            >
              <X className="w-5 h-5 text-ink-700/40" />
            </button>
          </div>

          <h2 className="text-lg font-bold text-ink-600 break-words leading-tight mb-5">
            {node.label}
          </h2>

          {hasRemembered ? (
            <section className="mb-6">
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                {t("drawer:section.whatRemembered")}
              </h4>
              {node.summary ? (
                <p className="text-sm text-ink-700 leading-relaxed whitespace-pre-wrap max-h-[28vh] overflow-y-auto pr-1">
                  {node.summary}
                </p>
              ) : null}
              {node.rationale ? (
                <p className="mt-3 text-xs text-ink-700/70 leading-relaxed">
                  <span className="font-bold text-ink-700">{t("drawer:rationale.label")}</span>{" "}
                  {node.rationale}
                </p>
              ) : null}
            </section>
          ) : null}

          {hasEvidence ? (
            <section className="mb-6">
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                {t("drawer:section.evidence")}
              </h4>
              <ul className="space-y-2">
                {node.evidence_refs?.map((ref) => (
                  <li
                    key={ref}
                    className="grid grid-cols-[1fr_auto] gap-2 rounded bg-beige-100 p-2 text-xs text-ink-700"
                  >
                    <span className="break-all">{ref}</span>
                    <button
                      onClick={() => onCopyCli(ref)}
                      className="text-ink-700/40 hover:text-ink-700"
                      aria-label={t("drawer:copyEvidence", { ref })}
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {hasTrust ? (
            <section className="mb-6">
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                {t("drawer:section.trust")}
              </h4>
              <div className="flex items-center gap-3 text-xs text-ink-700">
                <div className="h-2 flex-1 rounded bg-beige-200 overflow-hidden">
                  <div
                    className="h-full bg-state-ok"
                    style={{ width: `${Math.round((node.confidence ?? 0) * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums">{(node.confidence ?? 0).toFixed(2)}</span>
              </div>
            </section>
          ) : null}

          {hasUsage ? (
            <section className="mb-6">
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                {t("drawer:section.usage")}
              </h4>
              <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-xs">
                {node.last_used_at ? (
                  <>
                    <dt className="text-ink-700/60">{t("drawer:lastUsed.label")}</dt>
                    <dd className="text-ink-700" title={node.last_used_at}>
                      {formatRelativeTime(node.last_used_at)}
                    </dd>
                  </>
                ) : null}
                {node.last_hit_at ? (
                  <>
                    <dt className="text-ink-700/60">{t("drawer:lastHit.label")}</dt>
                    <dd className="text-ink-700" title={node.last_hit_at}>
                      {formatRelativeTime(node.last_hit_at)}
                    </dd>
                  </>
                ) : null}
                {node.influence_count !== undefined ? (
                  <>
                    <dt className="text-ink-700/60">{t("drawer:influence.label")}</dt>
                    <dd className="text-ink-700">
                      {t("drawer:usage.influence", {
                        count: node.influence_count,
                        plural: node.influence_count === 1 ? "" : "s"
                      })}
                    </dd>
                  </>
                ) : null}
              </dl>
            </section>
          ) : null}

          {canAct ? (
            <section className="mb-6">
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                {t("drawer:section.actions")}
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => void runAction("keep")}
                  disabled={busyAction !== null}
                  className="flex items-center justify-center gap-2 rounded bg-state-ok px-3 py-2 text-xs font-bold uppercase tracking-widest text-beige-50 disabled:opacity-50"
                >
                  <Check className="w-3 h-3" />
                  {t("drawer:action.keep")}
                </button>
                <button
                  onClick={() => void runAction("downgrade")}
                  disabled={busyAction !== null}
                  className="flex items-center justify-center gap-2 rounded bg-state-emphasis px-3 py-2 text-xs font-bold uppercase tracking-widest text-beige-50 disabled:opacity-50"
                >
                  <TrendingDown className="w-3 h-3" />
                  {t("drawer:action.downgrade")}
                </button>
                <button
                  onClick={() => void runAction("retire")}
                  disabled={busyAction !== null}
                  className="flex items-center justify-center gap-2 rounded bg-state-error px-3 py-2 text-xs font-bold uppercase tracking-widest text-beige-50 disabled:opacity-50"
                >
                  <Trash2 className="w-3 h-3" />
                  {t("drawer:action.retire")}
                </button>
              </div>
              <div className="mt-3 space-y-2">
                <textarea
                  value={rewriteContent}
                  onChange={(event) => setRewriteContent(event.target.value)}
                  className="min-h-24 w-full resize-y rounded border border-beige-200 bg-white p-2 text-xs text-ink-700 outline-none focus:border-ink-600"
                  aria-label={t("drawer:rewriteAria")}
                />
                <button
                  onClick={() => void runAction("rewrite", rewriteContent)}
                  disabled={busyAction !== null || rewriteContent.trim().length === 0}
                  className="flex w-full items-center justify-center gap-2 rounded bg-ink-600 px-3 py-2 text-xs font-bold uppercase tracking-widest text-beige-50 disabled:opacity-50"
                >
                  <Edit3 className="w-3 h-3" />
                  {t("drawer:action.rewrite")}
                </button>
              </div>
            </section>
          ) : null}

          <section className="mb-6">
            <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
              {t("drawer:section.spotlight")}
            </h4>
            <button
              onClick={() => onFocusSubgraph(node.id)}
              className="text-xs font-mono text-ink-600 underline hover:text-ink-700"
            >
              {t("drawer:focusOneHop")}
            </button>
          </section>

          <details className="mb-6">
            <summary className="cursor-pointer text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
              {t("drawer:section.metadata")}
            </summary>
            <dl className="bg-beige-100 p-3 rounded text-xs grid grid-cols-[5rem_1fr_auto] gap-x-3 gap-y-2 items-baseline">
              <dt className="text-ink-700/60">{t("drawer:meta.id")}</dt>
              <dd className="text-ink-700 break-all select-all">{node.id}</dd>
              <button
                onClick={() => onCopyCli(node.id)}
                className="text-ink-700/40 hover:text-ink-700"
                aria-label={t("drawer:copyNodeId")}
              >
                <Copy className="w-3 h-3" />
              </button>

              {node.scope_id ? (
                <>
                  <dt className="text-ink-700/60">{t("drawer:meta.scope")}</dt>
                  <dd className="text-ink-700 break-all col-span-2">{node.scope_id}</dd>
                </>
              ) : null}

              {node.workspace_id ? (
                <>
                  <dt className="text-ink-700/60">{t("drawer:meta.workspace")}</dt>
                  <dd className="text-ink-700 break-all col-span-2">{node.workspace_id}</dd>
                </>
              ) : null}

              {node.created_at ? (
                <>
                  <dt className="text-ink-700/60">{t("drawer:meta.created")}</dt>
                  <dd className="text-ink-700 col-span-2" title={node.created_at}>
                    {formatRelativeTime(node.created_at)}
                  </dd>
                </>
              ) : null}

              <dt className="text-ink-700/60">{t("drawer:meta.degree")}</dt>
              <dd className="text-ink-700 col-span-2">
                {node.degree ?? 0}{" "}
                <span className="text-ink-700/40">
                  {t("drawer:meta.connections", { plural: node.degree === 1 ? "" : "s" })}
                </span>
              </dd>
            </dl>
          </details>

          <div className="mt-auto pt-6 border-t border-beige-200">
            <button
              onClick={() => onCopyCli(cliCommand)}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-ink-600 text-beige-50 rounded hover:bg-ink-700 transition-colors text-xs font-bold uppercase tracking-widest"
            >
              <Terminal className="w-4 h-4" />
              {t("drawer:openInCli")}
              <Copy className="w-3 h-3 ml-auto opacity-60" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
