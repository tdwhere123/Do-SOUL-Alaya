import { Eye, EyeOff } from "lucide-react";
import { clsx } from "clsx";

export type SecretRefMode = "env" | "file" | "paste";

export interface ParsedSecretRef {
  readonly mode: SecretRefMode;
  readonly value: string;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

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

export function SecretRefField(props: {
  readonly mode: SecretRefMode;
  readonly value: string;
  readonly revealFile: boolean;
  readonly validationError: string | null;
  readonly onModeChange: (mode: SecretRefMode) => void;
  readonly onRevealFileChange: (value: boolean | ((current: boolean) => boolean)) => void;
  readonly onValidationErrorChange: (value: string | null) => void;
  readonly onValueChange: (value: string) => void;
}) {
  const visibleValue =
    props.mode === "file" && !props.revealFile && props.value ? maskFilePath(props.value) : props.value;
  return (
    <div className="flex flex-col items-end gap-2">
      <SecretModeChips mode={props.mode} onModeChange={props.onModeChange} />
      <div className="flex items-center gap-2">
        <SecretRevealButton {...props} />
        <input
          type={props.mode === "paste" ? "password" : "text"}
          value={visibleValue}
          onChange={(event) => props.onValueChange(event.target.value)}
          placeholder={secretPlaceholder(props.mode)}
          className={clsx(
            "bg-transparent border-b outline-none text-sm font-mono text-right py-1 min-w-[260px]",
            props.validationError
              ? "border-morandi-pink text-morandi-pink"
              : "border-beige-300 focus:border-ink-600 text-ink-700"
          )}
          onFocus={() => props.mode === "file" && props.onRevealFileChange(true)}
          onBlur={() => handleSecretBlur(props)}
        />
      </div>
      {props.validationError ? (
        <span className="text-[10px] text-morandi-pink">{props.validationError}</span>
      ) : null}
      {props.mode === "paste" ? (
        <span className="max-w-[260px] text-right text-[10px] text-ink-700/40">
          Paste is stored as a local file secret and returned as file:.
        </span>
      ) : null}
    </div>
  );
}

function SecretModeChips(props: {
  readonly mode: SecretRefMode;
  readonly onModeChange: (mode: SecretRefMode) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest">
      {(["env", "file", "paste"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => props.onModeChange(mode)}
          className={clsx(
            "px-2 py-0.5 rounded border transition-colors",
            props.mode === mode
              ? "bg-ink-600 text-beige-50 border-ink-600"
              : "bg-transparent text-ink-700/60 border-beige-300 hover:border-ink-600/40"
          )}
        >
          {mode}:
        </button>
      ))}
    </div>
  );
}

function SecretRevealButton(props: {
  readonly mode: SecretRefMode;
  readonly value: string;
  readonly revealFile: boolean;
  readonly onRevealFileChange: (value: boolean | ((current: boolean) => boolean)) => void;
}) {
  if (props.mode !== "file" || !props.value) return null;
  return (
    <button
      type="button"
      onClick={() => props.onRevealFileChange((current) => !current)}
      className="text-ink-700/40 hover:text-ink-700"
      aria-label={props.revealFile ? "Hide full path" : "Show full path"}
    >
      {props.revealFile ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
    </button>
  );
}

function handleSecretBlur(props: {
  readonly mode: SecretRefMode;
  readonly value: string;
  readonly onRevealFileChange: (value: boolean | ((current: boolean) => boolean)) => void;
  readonly onValidationErrorChange: (value: string | null) => void;
}) {
  props.onValidationErrorChange(validateSecretValue(props.mode, props.value));
  if (props.mode === "file") props.onRevealFileChange(false);
}

export function parseSecretRef(raw: string | null): ParsedSecretRef {
  if (!raw) return { mode: "env", value: "" };
  if (raw.startsWith("env:")) return { mode: "env", value: raw.slice(4) };
  if (raw.startsWith("file:")) return { mode: "file", value: raw.slice(5) };
  return { mode: "env", value: "" };
}

export function buildSecretRef(mode: Exclude<SecretRefMode, "paste">, value: string): string | null {
  if (value === "") return null;
  return `${mode}:${value}`;
}

export function buildSecretPatch(mode: SecretRefMode, value: string): {
  readonly secret_ref?: string | null;
  readonly secret_ref_mode?: SecretRefMode;
  readonly secret_value?: string | null;
} {
  if (value === "") return { secret_ref: null };
  if (mode === "paste") return { secret_ref_mode: "paste", secret_value: value };
  return { secret_ref_mode: mode, secret_value: value };
}

export function validateSecretValue(mode: SecretRefMode, value: string): string | null {
  if (value === "") return null;
  if (mode === "env" && !ENV_NAME_RE.test(value)) return "env name must be UPPER_SNAKE_CASE";
  if (mode === "file" && !value.startsWith("/")) return "file path must be absolute (start with /)";
  if (mode === "paste" && value.trim().length === 0) return "pasted key is required";
  return null;
}

function maskFilePath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs.length <= 2) return path;
  return `…/${segs[segs.length - 1]}`;
}

function secretPlaceholder(mode: SecretRefMode): string {
  if (mode === "env") return "OPENAI_API_KEY";
  if (mode === "file") return "/etc/alaya/secrets/openai";
  return "paste API key";
}
