import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Eye, EyeOff, Save } from "lucide-react";
import { clsx } from "clsx";
import { apiFetch, type ApiError } from "../api";
import { useToasts } from "./Toast";
import {
  EmbeddingStatusSchema,
  type EmbeddingStatus,
  type RuntimeEmbeddingConfig
} from "@do-soul/alaya-protocol";

interface PatchResult {
  readonly success?: boolean;
  readonly requires_daemon_restart?: boolean;
  readonly data?: unknown;
}

type SecretRefMode = "env" | "file" | "paste";

interface ParsedSecretRef {
  readonly mode: SecretRefMode;
  readonly value: string;
}

interface RuntimeEmbeddingConfigEnvelope {
  readonly success?: boolean;
  readonly data?: RuntimeEmbeddingConfig;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function parseSecretRef(raw: string | null): ParsedSecretRef {
  if (!raw) return { mode: "env", value: "" };
  if (raw.startsWith("env:")) return { mode: "env", value: raw.slice(4) };
  if (raw.startsWith("file:")) return { mode: "file", value: raw.slice(5) };
  return { mode: "env", value: "" };
}

function maskFilePath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs.length <= 2) return path;
  return `…/${segs[segs.length - 1]}`;
}

interface Props {
  readonly onRequiresRestart: () => void;
  readonly workspaceId: string;
}

export default function EmbeddingSupplementForm({ onRequiresRestart, workspaceId }: Props) {
  const { showToast } = useToasts();

  const [providerUrl, setProviderUrl] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [embeddingEnabled, setEmbeddingEnabled] = useState<boolean>(false);
  const [secretMode, setSecretMode] = useState<SecretRefMode>("env");
  const [secretValue, setSecretValue] = useState<string>("");

  const [revealFile, setRevealFile] = useState<boolean>(false);
  const [initial, setInitial] = useState<RuntimeEmbeddingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);

  // Fetch the workspace embedding-status so the form can surface init/runtime
  // failures (bad URL, unreachable endpoint, model unknown) inline rather
  // than letting them sit silently in daemon logs. The daemon already records
  // degraded_reason via the health-journal degradation path the moment recall
  // attempts to use the provider; we just expose what's already there.
  const refreshEmbeddingStatus = useCallback(async () => {
    try {
      const envelope = await apiFetch<{ data?: unknown }>(
        `/embedding-status/${workspaceId}`
      );
      const parsed = EmbeddingStatusSchema.safeParse(envelope.data);
      if (parsed.success) {
        setEmbeddingStatus(parsed.data);
      }
    } catch {
      // Non-fatal: leave previous status visible. The standalone /status page
      // owns the global "daemon unreachable" surfacing.
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const envelope = await apiFetch<RuntimeEmbeddingConfig | RuntimeEmbeddingConfigEnvelope>(
          `/config/${workspaceId}/embedding-supplement`
        );
        const data = unwrapRuntimeEmbeddingConfig(envelope);
        if (cancelled) return;
        setInitial(data);
        setProviderUrl(data.provider_url ?? "");
        setModelId(data.model_id ?? "");
        setEmbeddingEnabled(data.embedding_enabled);
        const parsed = parseSecretRef(data.secret_ref);
        setSecretMode(parsed.mode);
        setSecretValue(parsed.value);
      } catch (err) {
        if ((err as ApiError).status === 401) return;
        showToast({
          message: `Failed to load embedding config: ${(err as Error).message}`,
          type: "error"
        });
        return;
      } finally {
        if (!cancelled) setLoading(false);
      }
      // Fetch status AFTER config load completes — keeps the request order
      // deterministic for tests and avoids racing the config GET on mount.
      if (!cancelled) {
        await refreshEmbeddingStatus();
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, showToast, refreshEmbeddingStatus]);

  const dirty = useMemo(() => {
    if (!initial) return false;
    const builtRef = secretMode === "paste" ? initial.secret_ref : buildSecretRef(secretMode, secretValue);
    return (
      (initial.provider_url ?? "") !== providerUrl ||
      (initial.model_id ?? "") !== modelId ||
      initial.embedding_enabled !== embeddingEnabled ||
      (secretMode === "paste" ? secretValue !== "" : (initial.secret_ref ?? null) !== builtRef)
    );
  }, [initial, providerUrl, modelId, embeddingEnabled, secretMode, secretValue]);

  const handleSave = async () => {
    if (secretValue !== "") {
      const validation = validateSecretValue(secretMode, secretValue);
      if (validation) {
        setValidationError(validation);
        return;
      }
    }
    setValidationError(null);

    setSaving(true);
    try {
      const secretPatch = buildSecretPatch(secretMode, secretValue);
      const result = await apiFetch<PatchResult>("/config/runtime/embedding-supplement", {
        method: "PATCH",
        body: {
          provider_url: providerUrl === "" ? null : providerUrl,
          model_id: modelId === "" ? null : modelId,
          embedding_enabled: embeddingEnabled,
          ...secretPatch
        }
      });
      const sanitized = unwrapRuntimeEmbeddingConfig(result.data);
      showToast({
        message: "Embedding supplement patched · daemon restart pending",
        type: "success"
      });
      if (result.requires_daemon_restart) {
        onRequiresRestart();
      }
      setInitial({
        provider_url: sanitized?.provider_url ?? (providerUrl === "" ? null : providerUrl),
        model_id: sanitized?.model_id ?? (modelId === "" ? null : modelId),
        embedding_enabled: sanitized?.embedding_enabled ?? embeddingEnabled,
        secret_ref: sanitized?.secret_ref ?? secretPatch.secret_ref ?? null
      });
      const returnedRef = sanitized?.secret_ref ?? secretPatch.secret_ref ?? null;
      const parsed = parseSecretRef(returnedRef);
      setSecretMode(parsed.mode);
      setSecretValue(parsed.value);
      // Note: we don't re-fetch /embedding-status here. The daemon must be
      // restarted to apply config changes anyway, so the pre-restart status
      // snapshot is meaningless. The next mount (after the user restarts the
      // daemon and reloads the Inspector) will pick up the fresh status.
    } catch (err) {
      if ((err as ApiError).status === 401) return;
      showToast({
        message: `Failed to patch embedding: ${(err as Error).message}`,
        type: "error"
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="py-4 text-xs text-ink-700/40 uppercase tracking-widest animate-pulse">
        Loading Embedding Supplement...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {embeddingStatus !== null && embeddingStatus.effective_mode === "degraded" ? (
        <div
          role="alert"
          className="flex items-start gap-3 px-4 py-3 bg-[#C9ADA7]/15 border border-[#C9ADA7] rounded text-xs text-ink-700"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 text-[#C9ADA7] shrink-0" />
          <div className="flex-1 space-y-1 min-w-0">
            <p className="font-bold uppercase tracking-widest">
              Embedding Degraded
            </p>
            <p className="text-ink-700/80 break-words">
              {humanizeDegradedReason(embeddingStatus.degraded_reason)}
            </p>
            <p className="text-[10px] text-ink-700/50 font-mono">
              checked {embeddingStatus.checked_at}
            </p>
          </div>
        </div>
      ) : null}
      <FieldRow label="provider url">
        <input
          type="text"
          value={providerUrl}
          onChange={(e) => setProviderUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
          className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[260px]"
        />
      </FieldRow>

      <FieldRow label="model id">
        <input
          type="text"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder="text-embedding-3-small"
          className="bg-transparent border-b border-beige-300 focus:border-ink-600 outline-none text-sm text-ink-700 font-mono text-right py-1 min-w-[260px]"
        />
      </FieldRow>

      <FieldRow label="embedding enabled">
        <button
          type="button"
          onClick={() => setEmbeddingEnabled((v) => !v)}
          className={clsx(
            "w-10 h-5 rounded-full relative transition-colors duration-300",
            embeddingEnabled ? "bg-morandi-green" : "bg-beige-300"
          )}
          aria-pressed={embeddingEnabled}
          aria-label="Toggle embedding"
        >
          <div
            className={clsx(
              "absolute top-1 w-3 h-3 rounded-full bg-beige-50 transition-transform duration-300",
              embeddingEnabled ? "left-6" : "left-1"
            )}
          />
        </button>
      </FieldRow>

      <FieldRow label="secret ref">
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest">
            {(["env", "file", "paste"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSecretMode(mode)}
                className={clsx(
                  "px-2 py-0.5 rounded border transition-colors",
                  secretMode === mode
                    ? "bg-ink-600 text-beige-50 border-ink-600"
                    : "bg-transparent text-ink-700/60 border-beige-300 hover:border-ink-600/40"
                )}
              >
                {mode}:
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {secretMode === "file" && secretValue ? (
              <button
                type="button"
                onClick={() => setRevealFile((v) => !v)}
                className="text-ink-700/40 hover:text-ink-700"
                aria-label={revealFile ? "Hide full path" : "Show full path"}
              >
                {revealFile ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            ) : null}
            <input
              type={secretMode === "paste" ? "password" : "text"}
              value={
                secretMode === "file" && !revealFile && secretValue
                  ? maskFilePath(secretValue)
                  : secretValue
              }
              onChange={(e) => setSecretValue(e.target.value)}
              placeholder={
                secretMode === "env"
                  ? "OPENAI_API_KEY"
                  : secretMode === "file"
                    ? "/etc/alaya/secrets/openai"
                    : "paste API key"
              }
              className={clsx(
                "bg-transparent border-b outline-none text-sm font-mono text-right py-1 min-w-[260px]",
                validationError
                  ? "border-[#C9ADA7] text-[#C9ADA7]"
                  : "border-beige-300 focus:border-ink-600 text-ink-700"
              )}
              onFocus={() => secretMode === "file" && setRevealFile(true)}
              onBlur={() => {
                const err = validateSecretValue(secretMode, secretValue);
                setValidationError(err);
                if (secretMode === "file") setRevealFile(false);
              }}
            />
          </div>
          {validationError ? (
            <span className="text-[10px] text-[#C9ADA7]">{validationError}</span>
          ) : null}
          {secretMode === "paste" ? (
            <span className="max-w-[260px] text-right text-[10px] text-ink-700/40">
              Paste is stored as a local file secret and returned as file:.
            </span>
          ) : null}
        </div>
      </FieldRow>

      <div className="pt-4 flex items-center justify-between">
        <span className="text-[10px] text-ink-700/40 uppercase tracking-widest">
          {dirty ? "unsaved changes" : "in sync with daemon"}
        </span>
        <button
          onClick={handleSave}
          disabled={saving || !dirty || validationError !== null}
          className="flex items-center gap-2 px-4 py-2 bg-ink-600 text-beige-50 rounded text-xs font-bold uppercase tracking-widest hover:bg-ink-700 disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving..." : (
            <>
              <Save className="w-4 h-4" />
              Commit Embedding
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2">
      <label className="text-xs font-mono text-ink-700/60 uppercase tracking-widest">
        {label}
      </label>
      <div>{children}</div>
    </div>
  );
}

// Map daemon-side degraded_reason codes to operator-readable hints.
// Unknown codes fall through to a neutral message so the form never shows
// raw enum text.
function humanizeDegradedReason(reason: string | null): string {
  if (reason === null || reason === "") {
    return "Embedding marked degraded but no reason was reported. Check daemon logs.";
  }
  switch (reason) {
    case "provider_unconfigured":
      return "Provider is not configured. Set the secret_ref and re-save, then restart the daemon.";
    case "storage_unavailable":
      return "Embedding storage table is missing. Run `alaya doctor` to verify schema migration.";
    case "provider_unavailable":
      return "Provider rejected our request (auth or network). Verify the secret_ref points to a valid key and the provider URL is reachable.";
    case "query_embedding_failed":
      return "Provider returned an error when embedding a query. Verify the model id is supported by your endpoint.";
    case "local_vector_lookup_failed":
      return "Local embedding vector lookup failed. Restart the daemon; if it persists, run `alaya doctor`.";
    default:
      return `Provider reports: ${reason}. See daemon logs for the full error.`;
  }
}

function buildSecretRef(mode: Exclude<SecretRefMode, "paste">, value: string): string | null {
  if (value === "") return null;
  return `${mode}:${value}`;
}

function buildSecretPatch(mode: SecretRefMode, value: string): {
  readonly secret_ref?: string | null;
  readonly secret_ref_mode?: SecretRefMode;
  readonly secret_value?: string | null;
} {
  if (value === "") {
    return { secret_ref: null };
  }
  if (mode === "paste") {
    return {
      secret_ref_mode: "paste",
      secret_value: value
    };
  }
  return {
    secret_ref_mode: mode,
    secret_value: value
  };
}

function validateSecretValue(mode: SecretRefMode, value: string): string | null {
  if (value === "") return null;
  if (mode === "env") {
    if (!ENV_NAME_RE.test(value)) {
      return "env name must be UPPER_SNAKE_CASE";
    }
  } else if (mode === "file") {
    if (!value.startsWith("/")) {
      return "file path must be absolute (start with /)";
    }
  } else if (mode === "paste") {
    if (value.trim().length === 0) {
      return "pasted key is required";
    }
  }
  return null;
}

function unwrapRuntimeEmbeddingConfig(value: unknown): RuntimeEmbeddingConfig {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof (value as RuntimeEmbeddingConfigEnvelope).data === "object"
  ) {
    return (value as RuntimeEmbeddingConfigEnvelope).data as RuntimeEmbeddingConfig;
  }
  return value as RuntimeEmbeddingConfig;
}
