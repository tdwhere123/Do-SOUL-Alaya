import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { RuntimeEmbeddingConfigPatchSchema, type RuntimeEmbeddingConfigPatch } from "@do-soul/alaya-protocol";

export interface InspectorConfigPaths {
  readonly configDir: string;
  readonly envPath: string;
  readonly auditDir: string;
}

export function resolveInspectorConfigPaths(env: NodeJS.ProcessEnv = process.env): InspectorConfigPaths {
  const configDir = resolveInspectorConfigDir(env);
  return {
    configDir,
    envPath: path.join(configDir, ".env"),
    auditDir: path.join(configDir, "audit")
  };
}

export async function patchRuntimeEmbeddingEnv(input: {
  readonly patch: unknown;
  readonly paths: InspectorConfigPaths;
  readonly clock?: () => string;
}): Promise<Readonly<{ readonly patch: RuntimeEmbeddingConfigPatch; readonly audit_path: string }>> {
  const parsedPatch = RuntimeEmbeddingConfigPatchSchema.parse(input.patch);
  const existing = parseEnv(await readOptional(input.paths.envPath));
  const next = new Map(existing);
  if (parsedPatch.embedding_enabled !== undefined) {
    next.set("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", parsedPatch.embedding_enabled ? "true" : "false");
  }
  if (parsedPatch.secret_ref !== undefined) {
    if (parsedPatch.secret_ref === null) {
      next.delete("OPENAI_API_KEY");
    } else {
      assertSecretRef(parsedPatch.secret_ref);
      next.set("OPENAI_API_KEY", parsedPatch.secret_ref);
    }
  }
  if (parsedPatch.model_id !== undefined) {
    setOrDelete(next, "OPENAI_EMBEDDING_MODEL", parsedPatch.model_id);
  }
  if (parsedPatch.provider_url !== undefined) {
    setOrDelete(next, "OPENAI_EMBEDDING_PROVIDER_URL", parsedPatch.provider_url);
  }

  const now = input.clock ?? (() => new Date().toISOString());
  const timestamp = now();
  await mkdir(input.paths.configDir, { recursive: true, mode: 0o700 });
  await mkdir(input.paths.auditDir, { recursive: true, mode: 0o700 });
  await writeTextAtomic(input.paths.envPath, renderEnv(next), 0o600);
  const auditPath = path.join(input.paths.auditDir, `inspector-embedding-${timestamp.replace(/:/g, "-")}.json`);
  await writeTextAtomic(
    auditPath,
    `${JSON.stringify({
      audit_version: 1,
      event_kind: "inspector_runtime_embedding_patch",
      status: "succeeded",
      changed_keys: Object.keys(parsedPatch),
      secret_ref: parsedPatch.secret_ref ?? null,
      embedding_enabled: parsedPatch.embedding_enabled ?? null,
      created_at: timestamp
    })}\n`,
    0o600
  );
  return { patch: parsedPatch, audit_path: auditPath };
}

function resolveInspectorConfigDir(env: NodeJS.ProcessEnv): string {
  const override = env.ALAYA_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.resolve(xdg, "alaya");
  return path.resolve(env.HOME?.trim() || homedir(), ".config", "alaya");
}

function parseEnv(content: string | null): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of (content ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return entries;
}

function renderEnv(entries: ReadonlyMap<string, string>): string {
  return `${Array.from(entries.entries()).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeTextAtomic(filePath: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, { encoding: "utf8", mode });
  await rename(tempPath, filePath);
}

function setOrDelete(map: Map<string, string>, key: string, value: string | null): void {
  if (value === null) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

function assertSecretRef(secretRef: string): void {
  if (!secretRef.startsWith("env:") && !secretRef.startsWith("file:")) {
    throw new Error("secret_ref must start with env: or file:");
  }
}
