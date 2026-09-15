import { vi } from "vitest";
import { auditOfficialApiSignalFormation, OfficialApiGardenProvider } from "@do-soul/alaya-soul";

// These receipt/payload tests consume historical signal envelopes. The live
// provider now receives interpretations; only its seed-adapter interface is used.
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
