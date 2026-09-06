export const EXTRACTION_CAPABILITY_CATALOG_VERSION = 1;

export interface ExtractionCapabilityContract {
  readonly id: string;
  readonly version: string;
  readonly requirements: readonly string[];
  readonly materializer: "official_api_signals" | null;
}

export const OFFICIAL_API_SIGNALS_CAPABILITY: ExtractionCapabilityContract = Object.freeze({
  id: "official_api_signals",
  version: "v1",
  requirements: Object.freeze([]),
  materializer: "official_api_signals"
});

export const TEMPORAL_VALIDITY_CAPABILITY: ExtractionCapabilityContract = Object.freeze({
  id: "temporal_validity",
  version: "v1",
  requirements: Object.freeze(["official_api_signals:v1"]),
  materializer: null
});

const CATALOG: Readonly<Record<string, ExtractionCapabilityContract>> = Object.freeze({
  "official_api_signals:v1": OFFICIAL_API_SIGNALS_CAPABILITY,
  "temporal_validity:v1": TEMPORAL_VALIDITY_CAPABILITY
});

export function capabilityIdentity(contract: ExtractionCapabilityContract): string {
  return `${contract.id}:${contract.version}`;
}

export function lookupExtractionCapability(
  capability: string
): ExtractionCapabilityContract | undefined {
  return CATALOG[capability];
}

export function resolveExtractionCapability(capability: string): ExtractionCapabilityContract {
  const resolved = lookupExtractionCapability(capability);
  if (resolved === undefined) {
    throw new Error(`unknown extraction capability: ${capability}`);
  }
  return resolved;
}

export function capabilitiesAreCompatible(
  required: readonly string[],
  available: readonly string[]
): boolean {
  const admitted = new Set(available);
  return required.every((capability) => {
    resolveExtractionCapability(capability);
    return admitted.has(capability);
  });
}

export function supplementKey(semanticKey: string, capability: string): string {
  resolveExtractionCapability(capability);
  if (!/^[a-f0-9]{64}$/u.test(semanticKey)) {
    throw new Error("supplement key requires an assertion semantic key");
  }
  return `${semanticKey}:${capability}`;
}
