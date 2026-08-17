import { sha256Utf8 } from "../../../bench/diagnostic-loop/identity.js";
import { sharedSubstrateIdentities } from "../../../bench/diagnostic-loop/run.js";
import type {
  DiagnosticLoopAdapters,
  DiagnosticLoopIdentity,
  DiagnosticLoopPhaseResult,
  DiagnosticLoopRequest
} from "../../../bench/diagnostic-loop/types.js";
import type { DiagnosticLoopPhase } from "../../../bench/diagnostic-loop/phases.js";

export function digest(seed: string): string {
  return sha256Utf8(seed);
}

export function loopIdentity(
  overrides: Partial<DiagnosticLoopIdentity> = {}
): DiagnosticLoopIdentity {
  return {
    datasetRevision: digest("dataset"),
    requestedKeys: [digest("key-1")],
    providerRoute: "mimo",
    model: "mimo-v2-flash",
    requestProfile: "provider-default-v1",
    promptDigest: digest("prompt"),
    schemaDigest: digest("schema"),
    operatorDigest: digest("operator"),
    cacheMode: "cache_only",
    variant: "longmemeval_s",
    worker: false,
    ...overrides
  };
}

export function loopRequest(
  overrides: Partial<DiagnosticLoopRequest> = {}
): DiagnosticLoopRequest {
  return { ...loopIdentity(), ...overrides };
}

export function trackingAdapters(network: { calls: number } = { calls: 0 }): {
  readonly calls: DiagnosticLoopPhase[];
  readonly adapters: DiagnosticLoopAdapters;
} {
  const calls: DiagnosticLoopPhase[] = [];
  const handler = (phase: Exclude<DiagnosticLoopPhase, "report">) =>
    async (context: Parameters<DiagnosticLoopAdapters["preflight"]>[0]):
      Promise<DiagnosticLoopPhaseResult> => {
      calls.push(phase);
      return {
        contentIdentity: digest(`${phase}:${context.request.datasetRevision}`),
        physicalCalls: 0,
        artifactPaths: { [phase]: `${context.workRoot}/${phase}.json` },
        details: phase === "control_recall" || phase === "treatment_recall"
          ? sharedSubstrateIdentities(context)
          : {}
      };
    };
  return {
    calls,
    adapters: {
      preflight: handler("preflight"),
      authority_cache: handler("authority_cache"),
      extraction: async (context) => {
        if (network.calls > 0) network.calls += 1;
        return handler("extraction")(context);
      },
      snapshot: handler("snapshot"),
      control_recall: handler("control_recall"),
      treatment_recall: handler("treatment_recall"),
      miss_ledger: handler("miss_ledger")
    }
  };
}
