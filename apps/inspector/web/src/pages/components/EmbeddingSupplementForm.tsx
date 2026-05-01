import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Save } from "lucide-react";
import { clsx } from "clsx";
import { apiFetch, getWorkspaceId, type ApiError } from "../../api";
import { useToasts } from "../../components/Toast";
import type { RuntimeEmbeddingConfig } from "@do-soul/alaya-protocol";

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
}

export default function EmbeddingSupplementForm({ onRequiresRestart }: Props) {
  const workspaceId = getWorkspaceId() ?? "default";
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
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, showToast]);

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
