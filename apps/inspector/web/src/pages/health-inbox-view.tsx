import { RefreshCcw } from "lucide-react";
import { useI18n } from "../i18n/locale";
import type { DictKey } from "../i18n/dict";
import type { HealthInboxState } from "./health-inbox-state";
import {
  CAUSE_OPTIONS,
  SEVERITY_BADGE,
  STATE_OPTIONS,
  type CauseFilter,
  type HealthIssueCauseKind,
  type HealthIssueGroupRow,
  type StateFilter
} from "./health-inbox-types";

type Translate = (key: DictKey, params?: Record<string, string | number>) => string;

export function HealthInboxNoWorkspace(props: { readonly text: string }) {
  return <div className="p-8 font-mono text-sm text-ink-600">{props.text}</div>;
}

export function HealthInboxView(props: { readonly state: HealthInboxState }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col">
      <HealthInboxHeader state={props.state} t={t} />
      <HealthInboxContent state={props.state} t={t} />
    </div>
  );
}

function HealthInboxHeader(props: { readonly state: HealthInboxState; readonly t: Translate }) {
  return (
    <header className="border-b border-beige-300 bg-beige-50 px-6 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-mono uppercase tracking-widest text-ink-700">
          {props.t("healthInbox:title")}
        </h1>
        <RefreshButton state={props.state} t={props.t} />
      </div>
      <p className="mt-2 font-mono text-xs text-ink-500">{props.t("healthInbox:subtitle")}</p>
      <HealthInboxFilters state={props.state} t={props.t} />
    </header>
  );
}

function RefreshButton(props: { readonly state: HealthInboxState; readonly t: Translate }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 border border-beige-300 px-3 py-1.5 text-xs font-mono uppercase hover:bg-beige-100 disabled:opacity-50"
      disabled={props.state.refreshing}
      onClick={() => void props.state.refresh()}
      aria-label={props.t("common:refresh.aria")}
    >
      <RefreshCcw className={`h-3 w-3 ${props.state.refreshing ? "animate-spin" : ""}`} />
      {props.t("common:refresh")}
    </button>
  );
}

function HealthInboxFilters(props: { readonly state: HealthInboxState; readonly t: Translate }) {
  return (
    <div className="mt-4 flex flex-wrap gap-3">
      <FilterChipGroup<StateFilter>
        label={props.t("healthInbox:filter.state")}
        value={props.state.stateFilter}
        options={STATE_OPTIONS}
        onChange={props.state.setStateFilter}
      />
      <FilterChipGroup<CauseFilter>
        label={props.t("healthInbox:filter.causeKind")}
        value={props.state.causeFilter}
        options={CAUSE_OPTIONS}
        onChange={props.state.setCauseFilter}
        renderOptionLabel={(option) => causeFilterLabel(option, props.t)}
      />
    </div>
  );
}

function HealthInboxContent(props: { readonly state: HealthInboxState; readonly t: Translate }) {
  const state = props.state;
  if (state.loading) return <main className="flex-1 overflow-auto"><InboxMessage text={props.t("common:loading")} /></main>;
  if (state.error !== null) return <HealthInboxError error={state.error} t={props.t} />;
  if (state.groups.length === 0) {
    return <main className="flex-1 overflow-auto"><InboxMessage text={props.t("healthInbox:empty")} /></main>;
  }
  return (
    <main className="flex-1 overflow-auto">
      <ul className="divide-y divide-beige-200" data-testid="health-inbox-groups">
        {state.groupedByCause.map(([cause, rows]) => (
          <HealthIssueCauseGroup key={cause} cause={cause} rows={rows} t={props.t} />
        ))}
      </ul>
    </main>
  );
}

function HealthIssueCauseGroup(props: {
  readonly cause: HealthIssueCauseKind;
  readonly rows: readonly HealthIssueGroupRow[];
  readonly t: Translate;
}) {
  return (
    <li className="p-4">
      <h2 className="mb-2 font-mono text-xs uppercase tracking-widest text-ink-500">
        {props.t(`healthInbox:cause.${props.cause}` as DictKey)} · {props.rows.length}
      </h2>
      <ul className="space-y-3">
        {props.rows.map((row) => <HealthIssueGroupCard key={row.group_id} row={row} />)}
      </ul>
    </li>
  );
}

function HealthIssueGroupCard({ row }: { readonly row: HealthIssueGroupRow }) {
  const { t } = useI18n();
  return (
    <li data-testid="health-inbox-group" className="rounded border border-beige-300 bg-beige-50 p-3">
      <HealthIssueCardHeader row={row} t={t} />
      <div className="mb-1 break-all font-mono text-xs text-ink-600">
        {row.target_object_kind} · {row.target_object_id}
      </div>
      <HealthIssueFacts row={row} t={t} />
      <SuggestedActions row={row} t={t} />
    </li>
  );
}

function HealthIssueCardHeader(props: { readonly row: HealthIssueGroupRow; readonly t: Translate }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-mono uppercase ${SEVERITY_BADGE[props.row.severity]}`}>
        {props.row.severity}
      </span>
      <span className="font-mono text-[10px] text-ink-500">
        {props.t("healthInbox:row.lastSeen", { ts: props.row.last_seen_at })}
      </span>
    </div>
  );
}

function HealthIssueFacts(props: { readonly row: HealthIssueGroupRow; readonly t: Translate }) {
  const facts = [
    ["healthInbox:row.count", props.row.count],
    ["healthInbox:row.confidence", props.row.confidence.toFixed(2)],
    ["healthInbox:row.resolutionState", props.row.resolution_state],
    ["healthInbox:row.firstSeen", props.row.first_seen_at]
  ] as const;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-ink-700">
      {facts.map(([key, value]) => (
        <div key={key}>
          <span className="text-ink-500">{props.t(key as DictKey)}: </span>
          {value}
        </div>
      ))}
    </div>
  );
}

function SuggestedActions(props: { readonly row: HealthIssueGroupRow; readonly t: Translate }) {
  if (props.row.suggested_actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-ink-500">
        {props.t("healthInbox:row.suggestedActions")}:
      </span>
      {props.row.suggested_actions.map((action) => <ActionPill key={action} action={action} />)}
    </div>
  );
}

function ActionPill(props: { readonly action: string }) {
  return (
    <span className="border border-beige-300 bg-beige-100 px-1.5 py-0.5 text-[10px] font-mono text-ink-600">
      {props.action}
    </span>
  );
}

function FilterChipGroup<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly onChange: (next: T) => void;
  readonly renderOptionLabel?: (option: T) => string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-ink-500">
        {props.label}:
      </span>
      {props.options.map((option) => <FilterChip key={option} option={option} {...props} />)}
    </div>
  );
}

function FilterChip<T extends string>(props: {
  readonly option: T;
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly renderOptionLabel?: (option: T) => string;
}) {
  return (
    <button type="button" onClick={() => props.onChange(props.option)} className={filterChipClass(props.value === props.option)}>
      {props.renderOptionLabel?.(props.option) ?? props.option}
    </button>
  );
}

function HealthInboxError(props: { readonly error: string; readonly t: Translate }) {
  return (
    <main className="flex-1 overflow-auto">
      <div className="p-8 font-mono text-sm text-red-600">
        {props.t("common:error")}: {props.error}
      </div>
    </main>
  );
}

function InboxMessage(props: { readonly text: string }) {
  return <div className="p-8 font-mono text-sm text-ink-500">{props.text}</div>;
}

function causeFilterLabel(option: CauseFilter, t: Translate): string {
  return option === "all" ? option : t(`healthInbox:cause.${option}` as DictKey);
}

function filterChipClass(selected: boolean): string {
  return `px-2 py-0.5 text-[10px] font-mono uppercase border ${
    selected
      ? "bg-ink-600 text-beige-50 border-ink-600"
      : "border-beige-300 text-ink-600 hover:bg-beige-100"
  }`;
}
