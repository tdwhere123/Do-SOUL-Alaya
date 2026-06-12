import {
  ComputeProviderPriority,
  HealthEventKind,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import type { ConflictDetectionLlmPort } from "@do-soul/alaya-core";
import type { SqliteHealthJournalRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";
import {
  OFFICIAL_API_GARDEN_MODEL,
  type ComputeRoutingCandidate,
  type LocalHeuristics
} from "@do-soul/alaya-soul";
import { resolveSecretRef, type ResolveSecretError } from "../secrets/index.js";
import type { GardenComputeProviderResolver } from "../services/garden-compute-provider-resolver.js";

const DEFAULT_GARDEN_STATUS_WORKSPACE_ID = "default";

export async function resolvePersistedGardenLastPassAt(input: {
  readonly healthJournalRepo: SqliteHealthJournalRepo;
  readonly workspaceRepo: SqliteWorkspaceRepo;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}): Promise<string | null> {
  try {
    let latest: string | null = null;
    const workspaces = await input.workspaceRepo.list();
    const workspaceIds = new Set<string>([DEFAULT_GARDEN_STATUS_WORKSPACE_ID]);
    for (const workspace of workspaces) {
      workspaceIds.add(workspace.workspace_id);
    }
    for (const workspaceId of workspaceIds) {
      const [entry] = await input.healthJournalRepo.findByWorkspace(workspaceId, {
        kind: HealthEventKind.GARDEN_BACKLOG,
        limit: 1
      });
      if (entry === undefined) {
        continue;
      }
      if (latest === null || entry.created_at > latest) {
        latest = entry.created_at;
      }
    }
    return latest;
  } catch (error) {
    input.warn("garden persisted status lookup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

export function resolveGardenSecretRefValue(secretRef: string): string {
  const resolved = resolveSecretRef(secretRef);
  if (!("kind" in resolved)) {
    return resolved.value;
  }

  throw new Error(formatGardenSecretRefError(resolved));
}

export function buildGardenComputeRoutingProviders(input: {
  readonly config: RuntimeGardenComputeConfig;
  readonly officialGardenProvider: GardenComputeProviderResolver;
  readonly localHeuristicsProvider: LocalHeuristics;
}): readonly ComputeRoutingCandidate[] {
  return [
    ...(canResolveOfficialGardenProvider(input.config)
      ? [
          {
            kind: ComputeProviderPriority.OFFICIAL_API,
            provider: input.officialGardenProvider,
            model_id: input.config.model_id ?? OFFICIAL_API_GARDEN_MODEL,
            adapter: "garden.official_api"
          } satisfies ComputeRoutingCandidate
        ]
      : []),
    {
      kind: ComputeProviderPriority.STUB,
      provider: input.localHeuristicsProvider,
      model_id: "local-heuristics",
      adapter: "garden.local_heuristics"
    }
  ];
}

export function canResolveOfficialGardenProvider(config: RuntimeGardenComputeConfig): boolean {
  if (
    config.provider_kind !== "official_api" ||
    !config.enabled ||
    config.secret_ref === null
  ) {
    return false;
  }

  try {
    resolveGardenSecretRefValue(config.secret_ref);
    return true;
  } catch {
    return false;
  }
}

export function createConflictDetectionLlmPort(): ConflictDetectionLlmPort | null {
  const baseUrl = process.env.ALAYA_CONFLICT_LLM_PROVIDER_URL?.trim();
  const apiKey = process.env.ALAYA_CONFLICT_LLM_API_KEY?.trim();
  if (
    baseUrl === undefined ||
    baseUrl.length === 0 ||
    apiKey === undefined ||
    apiKey.length === 0
  ) {
    return null;
  }
  const model = process.env.ALAYA_CONFLICT_LLM_MODEL?.trim() ?? "gpt-5.4-mini";
  const parsedTimeout = Number.parseInt(
    process.env.ALAYA_CONFLICT_LLM_TIMEOUT_MS ?? "",
    10
  );
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 8000;

  return {
    classifyPair: async ({ newContent, existingContent, dimension, scopeClass }) => {
      const prompt = [
        `You are a deterministic memory ontology classifier for Alaya.`,
        `Two memory entries share dimension="${dimension}" and scope="${scopeClass}".`,
        `Decide their relationship: "contradicts" | "incompatible_with" | "none".`,
        ``,
        `MEMORY_A (new):`,
        newContent,
        ``,
        `MEMORY_B (existing):`,
        existingContent,
        ``,
        `Reply with one word only: contradicts, incompatible_with, or none.`
      ].join("\n");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "Reply with exactly one word." },
              { role: "user", content: prompt }
            ],
            temperature: 0,
            max_tokens: 8
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          return "none";
        }
        const data = (await response.json()) as {
          readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? "";
        if (text.startsWith("contradicts")) return "contradicts";
        if (text.startsWith("incompatible_with")) return "incompatible_with";
        return "none";
      } catch {
        return "none";
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

export function normalizeRecallTimeConcernWindowDigest(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

function formatGardenSecretRefError(error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `Garden compute secret_ref ${error.ref} is malformed: ${error.reason}`;
    case "empty":
      return `Garden compute secret_ref ${error.ref} resolved to an empty ${error.origin} secret.`;
    case "env_missing":
      return `Garden compute secret_ref ${error.ref} is missing environment variable ${error.var_name}.`;
    case "file_missing":
      return `Garden compute secret_ref ${error.ref} is missing file ${error.path}.`;
    case "file_unreadable":
      return `Garden compute secret_ref ${error.ref} file ${error.path} is unreadable.`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `Garden compute secret_ref ${error.ref} keychain lookup failed: ${error.reason}`;
  }
}
