import { clsx } from "clsx";
import { useI18n } from "../i18n/locale";

export function FieldRow(props: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2">
      <label className="text-xs font-mono text-ink-700/60 uppercase tracking-widest">
        {props.label}
      </label>
      <div>{props.children}</div>
    </div>
  );
}

export function ReadOnlyFieldRow(props: {
  readonly label: string;
  readonly value: unknown;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2">
      <span className="text-xs font-mono text-ink-700/60 uppercase tracking-widest">
        {props.label}
      </span>
      <span className="text-sm text-ink-700 font-mono text-right break-all">
        {displayValue(props.value)}
      </span>
    </div>
  );
}

export function RuntimeConfigReadOnlyNotice() {
  const { t } = useI18n();
  return (
    <div
      role="note"
      className="space-y-2 rounded border border-beige-300 bg-beige-200/50 px-4 py-3 text-xs text-ink-700"
    >
      <p className="font-bold uppercase tracking-widest">
        {t("config:runtimeConfig.readOnly.heading")}
      </p>
      <p className="text-ink-700/80">{t("config:runtimeConfig.readOnly.body")}</p>
      <div className="flex flex-wrap gap-2">
        <code className="rounded bg-beige-100 px-2 py-1 text-[10px]">
          alaya install --non-interactive '&lt;answers-json&gt;'
        </code>
        <code className="rounded bg-beige-100 px-2 py-1 text-[10px]">
          alaya install --keychain
        </code>
      </div>
    </div>
  );
}

export function ToggleSwitch(props: {
  readonly enabled: boolean;
  readonly label: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      className={clsx(
        "w-10 h-5 rounded-full relative transition-colors duration-300",
        props.enabled ? "bg-morandi-green" : "bg-beige-300"
      )}
      aria-pressed={props.enabled}
      aria-label={props.label}
    >
      <div
        className={clsx(
          "absolute top-1 w-3 h-3 rounded-full bg-beige-50 transition-transform duration-300",
          props.enabled ? "left-6" : "left-1"
        )}
      />
    </button>
  );
}

export function formatSecretRef(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (raw.startsWith("file:")) {
    return `file:${maskFilePath(raw.slice("file:".length))}`;
  }
  return raw;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function maskFilePath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs.length <= 2) return path;
  return `…/${segs[segs.length - 1]}`;
}
