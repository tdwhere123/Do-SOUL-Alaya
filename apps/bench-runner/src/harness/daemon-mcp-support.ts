import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type AlayaDaemonRuntime } from "@do-soul/alaya";
import { createAlayaCliBridge } from "@do-soul/alaya/cli/bridge";
import { registerAlayaCliCommands } from "@do-soul/alaya/cli/register";
import type { BenchRecallWeightOverrides } from "./recall-weight-overrides.js";

export function makeDispatchCli(
  runtime: AlayaDaemonRuntime
): (argv: readonly string[]) => Promise<{ exitCode: number; json?: unknown }> {
  return async (argv) => {
    const bridge = createAlayaCliBridge(runtime, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);
    return bridge.dispatch(argv);
  };
}

export async function callMcpTool<TOutput>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<TOutput> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const contentArray = Array.isArray(result.content)
      ? (result.content as readonly unknown[])
      : [];
    const errorText = contentArray
      .map((item) =>
        item !== null &&
        typeof item === "object" &&
        "text" in item &&
        typeof (item as { text: unknown }).text === "string"
          ? (item as { text: string }).text
          : ""
      )
      .join("\n");
    throw new Error(`MCP tool ${name} failed: ${errorText}`);
  }
  const structured = result.structuredContent as
    | Readonly<{ ok: true; output: TOutput }>
    | undefined;
  if (structured?.ok !== true) {
    throw new Error(`MCP tool ${name} returned non-ok structured content`);
  }
  return structured.output;
}

const DEFAULT_EMBEDDING_FUSION_WEIGHT_ON = 6;
const EMBEDDING_FUSION_WEIGHT_ENV = "ALAYA_EMBEDDING_FUSION_WEIGHT_ON";

// Mirror of apps/core-daemon/src/daemon-embedding-runtime.ts
// readEmbeddingFusionWeightOverride — the daemon's defaultPolicyDecorator
// reads the same env var to override fusion_weights.embedding_similarity in
// live recall. The bench harness drives recallService.recall directly with
// policyOverride (bypassing the decorator), so we inject the equivalent
// override here when embeddingMode === "env".
function readBenchEmbeddingFusionWeight(): number {
  const raw = process.env[EMBEDDING_FUSION_WEIGHT_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_EMBEDDING_FUSION_WEIGHT_ON;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_EMBEDDING_FUSION_WEIGHT_ON;
  }
  return parsed;
}

export function withEmbeddingFusionWeightInjected(
  existing: BenchRecallWeightOverrides | undefined
): BenchRecallWeightOverrides {
  const fusionWeight = readBenchEmbeddingFusionWeight();
  // A user-supplied embedding_similarity fusion weight (from CLI/env JSON)
  // wins over the harness default so bench tuning sweeps remain authoritative.
  const baseFusionWeights = existing?.fusionWeights ?? {};
  const mergedFusionWeights: Readonly<Record<string, number>> = Object.freeze({
    embedding_similarity: fusionWeight,
    ...baseFusionWeights
  });

  // Preserve the source of the user-supplied override when present; otherwise
  // tag the harness-injected slice as env-sourced for the summary log.
  const source: "cli" | "env" = existing?.source ?? "env";

  const summary = {
    source,
    ...(existing?.summary.activation_weights_phase4b === undefined
      ? {}
      : { activation_weights_phase4b: existing.summary.activation_weights_phase4b }),
    ...(existing?.summary.additive === undefined
      ? {}
      : { additive: existing.summary.additive }),
    fusion_weights: mergedFusionWeights
  };

  return Object.freeze({
    source,
    ...(existing?.activationWeightsPatch === undefined
      ? {}
      : { activationWeightsPatch: existing.activationWeightsPatch }),
    ...(existing?.additive === undefined
      ? {}
      : { additive: existing.additive }),
    fusionWeights: mergedFusionWeights,
    summary
  });
}

// When enabled, the LongMemEval / LoCoMo seeders stamp a per-session surface_id
// so delivery-time session coverage has a grouping axis (off => surface_id null
// => coverage rerank is a no-op, default-identical recall).
export function benchSessionSurfacesEnabled(): boolean {
  const raw = process.env.ALAYA_BENCH_SESSION_SURFACES?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

