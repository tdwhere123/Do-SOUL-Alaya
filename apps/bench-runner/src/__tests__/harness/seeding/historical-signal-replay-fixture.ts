import { vi } from "vitest";
import { auditOfficialApiSignalFormation, OfficialApiGardenProvider, type GardenCompileContext } from "@do-soul/alaya-soul";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";

/** Inspection drafts for the historical grounding/receipt suites, never current compile publication. */
export async function readHistoricalSeedInputs(input: { provider: OfficialApiGardenProvider;
  turnContent: string; seedIndex: number; context: GardenCompileContext }): Promise<readonly Omit<BenchSignalSeedInput, "evidenceRef">[]> {
  const signals = await input.provider.compile(input.turnContent, input.context);
  return signals.map(signal => ({ signalKind: signal.signal_kind,
    ...(signal.object_kind === null ? {} : { objectKind: signal.object_kind }),
    ...(signal.confidence === null ? {} : { confidence: signal.confidence }),
    distilledFact: typeof signal.raw_payload.distilled_fact === "string" ? signal.raw_payload.distilled_fact
      : typeof signal.raw_payload.matched_text === "string" ? signal.raw_payload.matched_text : "",
    turnContent: input.turnContent, turnMessages: input.context.turn_messages, turnSeedIndex: input.seedIndex,
    productionSignalId: signal.signal_id, productionRawPayload: signal.raw_payload, extractionProvider: "official_api_compile" }));
}

// These receipt/payload tests consume historical signal envelopes. The live
// provider receives statements. These mocks are only recorded legacy parser fixtures.
export function createHistoricalSignalReplayProvider(
  options: NonNullable<ConstructorParameters<typeof OfficialApiGardenProvider>[0]>
): OfficialApiGardenProvider {
  const provider = new OfficialApiGardenProvider({ apiKey: null, diagnosticDir: null });
  vi.spyOn(provider, "compile").mockImplementation(async (turnContent, context) => {
    if (options.extractor === undefined) throw new Error("historical fixture requires recorded raw response");
    const response = await options.extractor.extract({ systemPrompt: "historical-signals-fixture", userPrompt: turnContent });
    const audit = auditOfficialApiSignalFormation({
      raw_json: response.rawJson, turn_content: turnContent,
      turn_messages: context.turn_messages,
      workspace_id: context.workspace_id, run_id: context.run_id,
      surface_id: context.surface_id,
      allow_legacy_single_user_source: true,
      created_at: "2026-08-01T00:00:00.000Z",
      source_observed_at: "2026-08-01T00:00:00.000Z",
      signal_id_for: (index) => options.generateSignalId?.() ?? `historical-signal-${index}`
    });
    return audit.entries.flatMap((entry) => entry.signal === undefined ? [] : [entry.signal]);
  });
  return provider;
}

export function installHistoricalSignalReplay(rawJson: string): void {
  const provider = createHistoricalSignalReplayProvider({ apiKey: null,
    extractor: { extract: async () => ({ rawJson }) } });
  vi.spyOn(OfficialApiGardenProvider.prototype, "compile").mockImplementation(provider.compile);
}
