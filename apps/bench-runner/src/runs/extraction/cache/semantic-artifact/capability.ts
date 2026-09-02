export const EXTRACTION_CAPABILITY_CATALOG_VERSION = 1;

export interface ExtractionCapabilityContract {
  readonly id: string;
  readonly version: string;
  readonly requirements: readonly string[];
}

export const OFFICIAL_API_SIGNALS_CAPABILITY: ExtractionCapabilityContract = Object.freeze({
  id: "official_api_signals",
  version: "v1",
  requirements: Object.freeze([])
});

export const TEMPORAL_VALIDITY_CAPABILITY: ExtractionCapabilityContract = Object.freeze({
  id: "temporal_validity",
  version: "v1",
  requirements: Object.freeze(["official_api_signals:v1"])
});

const CATALOG: Readonly<Record<string, ExtractionCapabilityContract>> = Object.freeze({
  "official_api_signals:v1": OFFICIAL_API_SIGNALS_CAPABILITY,
  "temporal_validity:v1": TEMPORAL_VALIDITY_CAPABILITY
});

export function capabilityIdentity(contract: ExtractionCapabilityContract): string {
  return `${contract.id}:${contract.version}`;
}

export function resolveExtractionCapability(capability: string): ExtractionCapabilityContract {
  const resolved = CATALOG[capability];
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
