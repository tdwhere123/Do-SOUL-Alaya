import { GardenProviderKind, GardenProviderError, type GardenComputeProvider, type GardenCompileContext } from "./official-api-garden-provider.js";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

/** Persisted daemon configurations still name local_heuristics. Remove this selector adapter when
 * that configuration value is migrated; it never runs the retired heuristic extractor. */
export class UnavailableGardenProvider implements GardenComputeProvider {
  public readonly provider_kind = GardenProviderKind.LOCAL_HEURISTICS;
  public async compile(_content: string, _context: GardenCompileContext): Promise<readonly CandidateMemorySignal[]> {
    throw new GardenProviderError("Passive conversation extraction is unavailable; no statements were emitted.", "provider_failure");
  }
}
