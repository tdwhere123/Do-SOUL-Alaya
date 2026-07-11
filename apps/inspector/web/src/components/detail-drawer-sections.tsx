import { Check, Copy, Edit3, Terminal, Trash2, TrendingDown, X } from "lucide-react";
import { clsx } from "clsx";
import type { GraphNode } from "../types/graph";
import { formatRelativeTime } from "../utils/graph";
import { useI18n } from "../i18n/locale";
import type { DictKey } from "../i18n/dict";
import type { DetailDrawerState } from "./detail-drawer-state";

const ORIGIN_KIND_LABEL_KEYS: Readonly<Record<string, DictKey>> = {
  user_memory: "graph:legend.user_memory",
  engineering_chunk: "graph:legend.engineering_chunk",
  reviewed_engineering_chunk: "graph:legend.reviewed_engineering_chunk",
  proposal_pending: "graph:legend.proposal_pending",
  system: "graph:legend.system"
};

export function DetailDrawerShell(props: {
  readonly node: GraphNode | null;
  readonly kindColor: string;
  readonly ariaLabel: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        "absolute right-0 top-0 h-full w-full max-w-[24rem] bg-beige-50 border-l border-beige-200 shadow-2xl transition-transform duration-300 transform sm:w-96",
        props.node ? "translate-x-0" : "translate-x-full"
      )}
      role="complementary"
      aria-label={props.ariaLabel}
    >
      {props.node ? (
        <div className="relative h-full flex flex-col p-6 pl-7 font-mono overflow-y-auto">
          <div
            className="absolute left-0 top-0 bottom-0 w-1"
            style={{ backgroundColor: props.kindColor }}
            aria-hidden
          />
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

export function DetailDrawerContent(props: {
  readonly node: GraphNode;
  readonly state: DetailDrawerState;
  readonly onClose: () => void;
  readonly onCopyCli: (text: string) => void;
  readonly onFocusSubgraph: (id: string) => void;
}) {
  return (
    <>
      <DrawerHeader node={props.node} kindColor={props.state.kindColor} onClose={props.onClose} />
      <h2 className="text-lg font-bold text-ink-600 break-words leading-tight mb-5">
        {props.node.label}
      </h2>
      {props.state.hasRemembered ? <RememberedSection node={props.node} /> : null}
      {props.state.hasEvidence ? (
        <EvidenceSection node={props.node} onCopyCli={props.onCopyCli} />
      ) : null}
      {props.state.hasTrust ? <TrustSection node={props.node} /> : null}
      {props.state.hasUsage ? <UsageSection node={props.node} /> : null}
      {props.state.canAct ? <ActionsSection state={props.state} /> : null}
      <SpotlightSection node={props.node} onFocusSubgraph={props.onFocusSubgraph} />
      <MetadataSection node={props.node} onCopyCli={props.onCopyCli} />
      <OpenCliButton cliCommand={props.state.cliCommand} onCopyCli={props.onCopyCli} />
    </>
  );
}

function DrawerHeader(props: {
  readonly node: GraphNode;
  readonly kindColor: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex justify-between items-start mb-4">
      <NodeBadges node={props.node} kindColor={props.kindColor} />
      <button
        onClick={props.onClose}
        className="p-1 hover:bg-beige-200 rounded transition-colors -mr-1"
        aria-label={t("drawer:close")}
      >
        <X className="w-5 h-5 text-ink-700/40" />
      </button>
    </div>
  );
}

function NodeBadges({ node, kindColor }: { readonly node: GraphNode; readonly kindColor: string }) {
  const { t } = useI18n();
  return (
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
  );
}

function RememberedSection({ node }: { readonly node: GraphNode }) {
  const { t } = useI18n();
  return (
    <section className="mb-6">
      <SectionTitle label={t("drawer:section.whatRemembered")} />
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
  );
}

function EvidenceSection(props: {
  readonly node: GraphNode;
  readonly onCopyCli: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="mb-6">
      <SectionTitle label={t("drawer:section.evidence")} />
      <ul className="space-y-2">
        {props.node.evidence_refs?.map((ref) => (
          <li
            key={ref}
            className="grid grid-cols-[1fr_auto] gap-2 rounded bg-beige-100 p-2 text-xs text-ink-700"
          >
            <span className="break-all">{ref}</span>
            <button
              onClick={() => props.onCopyCli(ref)}
              className="text-ink-700/40 hover:text-ink-700"
              aria-label={t("drawer:copyEvidence", { ref })}
            >
              <Copy className="w-3 h-3" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TrustSection({ node }: { readonly node: GraphNode }) {
  const { t } = useI18n();
  return (
    <section className="mb-6">
      <SectionTitle label={t("drawer:section.trust")} />
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
  );
}

function UsageSection({ node }: { readonly node: GraphNode }) {
  const { t } = useI18n();
  return (
    <section className="mb-6">
      <SectionTitle label={t("drawer:section.usage")} />
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-xs">
        {node.last_used_at ? <RelativeTimeRow label={t("drawer:lastUsed.label")} value={node.last_used_at} /> : null}
        {node.last_hit_at ? <RelativeTimeRow label={t("drawer:lastHit.label")} value={node.last_hit_at} /> : null}
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
  );
}

function ActionsSection({ state }: { readonly state: DetailDrawerState }) {
  const { t } = useI18n();
  return (
    <section className="mb-6">
      <SectionTitle label={t("drawer:section.actions")} />
      <div className="grid grid-cols-2 gap-2">
        <ProposalButton icon={<Check className="w-3 h-3" />} label={t("drawer:action.keep")} onClick={() => state.runAction("keep")} tone="ok" disabled={state.busyAction !== null} />
        <ProposalButton icon={<TrendingDown className="w-3 h-3" />} label={t("drawer:action.downgrade")} onClick={() => state.runAction("downgrade")} tone="emphasis" disabled={state.busyAction !== null} />
        <ProposalButton icon={<Trash2 className="w-3 h-3" />} label={t("drawer:action.retire")} onClick={() => state.runAction("retire")} tone="error" disabled={state.busyAction !== null} />
      </div>
      <div className="mt-3 space-y-2">
        <textarea
          value={state.rewriteContent}
          onChange={(event) => state.setRewriteContent(event.target.value)}
          className="min-h-24 w-full resize-y rounded border border-beige-200 bg-white p-2 text-xs text-ink-700 outline-none focus:border-ink-600"
          aria-label={t("drawer:rewriteAria")}
        />
        <ProposalButton
          fullWidth
          icon={<Edit3 className="w-3 h-3" />}
          label={t("drawer:action.rewrite")}
          onClick={() => state.runAction("rewrite", state.rewriteContent)}
          tone="ink"
          disabled={state.busyAction !== null || state.rewriteContent.trim().length === 0}
        />
      </div>
    </section>
  );
}

function ProposalButton(props: {
  readonly disabled: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly tone: "ok" | "emphasis" | "error" | "ink";
  readonly fullWidth?: boolean;
}) {
  const toneClass = {
    ok: "bg-state-ok",
    emphasis: "bg-state-emphasis",
    error: "bg-state-error",
    ink: "bg-ink-600"
  }[props.tone];
  return (
    <button
      onClick={() => void props.onClick()}
      disabled={props.disabled}
      className={`${props.fullWidth ? "w-full " : ""}flex items-center justify-center gap-2 rounded ${toneClass} px-3 py-2 text-xs font-bold uppercase tracking-widest text-beige-50 disabled:opacity-50`}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function SpotlightSection(props: {
  readonly node: GraphNode;
  readonly onFocusSubgraph: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="mb-6">
      <SectionTitle label={t("drawer:section.spotlight")} />
      <button
        onClick={() => props.onFocusSubgraph(props.node.id)}
        className="text-xs font-mono text-ink-600 underline hover:text-ink-700"
      >
        {t("drawer:focusOneHop")}
      </button>
    </section>
  );
}

function MetadataSection(props: {
  readonly node: GraphNode;
  readonly onCopyCli: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <details className="mb-6">
      <summary className="cursor-pointer text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
        {t("drawer:section.metadata")}
      </summary>
      <dl className="bg-beige-100 p-3 rounded text-xs grid grid-cols-[5rem_1fr_auto] gap-x-3 gap-y-2 items-baseline">
        <MetadataIdRow node={props.node} onCopyCli={props.onCopyCli} />
        {props.node.scope_id ? <MetadataTextRow label={t("drawer:meta.scope")} value={props.node.scope_id} /> : null}
        {props.node.workspace_id ? <MetadataTextRow label={t("drawer:meta.workspace")} value={props.node.workspace_id} /> : null}
        {props.node.created_at ? <MetadataCreatedRow createdAt={props.node.created_at} /> : null}
        <MetadataDegreeRow node={props.node} />
      </dl>
    </details>
  );
}

function MetadataIdRow(props: {
  readonly node: GraphNode;
  readonly onCopyCli: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <dt className="text-ink-700/60">{t("drawer:meta.id")}</dt>
      <dd className="text-ink-700 break-all select-all">{props.node.id}</dd>
      <button
        onClick={() => props.onCopyCli(props.node.id)}
        className="text-ink-700/40 hover:text-ink-700"
        aria-label={t("drawer:copyNodeId")}
      >
        <Copy className="w-3 h-3" />
      </button>
    </>
  );
}

function MetadataTextRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-ink-700/60">{label}</dt>
      <dd className="text-ink-700 break-all col-span-2">{value}</dd>
    </>
  );
}

function MetadataCreatedRow({ createdAt }: { readonly createdAt: string }) {
  const { t } = useI18n();
  return (
    <>
      <dt className="text-ink-700/60">{t("drawer:meta.created")}</dt>
      <dd className="text-ink-700 col-span-2" title={createdAt}>
        {formatRelativeTime(createdAt)}
      </dd>
    </>
  );
}

function MetadataDegreeRow({ node }: { readonly node: GraphNode }) {
  const { t } = useI18n();
  return (
    <>
      <dt className="text-ink-700/60">{t("drawer:meta.degree")}</dt>
      <dd className="text-ink-700 col-span-2">
        {node.degree ?? 0}{" "}
        <span className="text-ink-700/40">
          {t("drawer:meta.connections", { plural: node.degree === 1 ? "" : "s" })}
        </span>
      </dd>
    </>
  );
}

function OpenCliButton(props: {
  readonly cliCommand: string;
  readonly onCopyCli: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-auto pt-6 border-t border-beige-200">
      <button
        onClick={() => props.onCopyCli(props.cliCommand)}
        className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-ink-600 text-beige-50 rounded hover:bg-ink-700 transition-colors text-xs font-bold uppercase tracking-widest"
      >
        <Terminal className="w-4 h-4" />
        {t("drawer:openInCli")}
        <Copy className="w-3 h-3 ml-auto opacity-60" />
      </button>
    </div>
  );
}

function RelativeTimeRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-ink-700/60">{label}</dt>
      <dd className="text-ink-700" title={value}>
        {formatRelativeTime(value)}
      </dd>
    </>
  );
}

function SectionTitle({ label }: { readonly label: string }) {
  return <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">{label}</h4>;
}
