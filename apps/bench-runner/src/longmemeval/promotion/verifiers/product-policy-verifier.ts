export function assertProductDefaultRecallEnvironment(
  _env: Readonly<Record<string, string | undefined>>,
  _options: object,
  _recallWeightOverrides: unknown,
  _context: string
): void {}

export function assertProductDefaultRunProvenancePolicy(
  _provenance: object,
  _context: string
): void {}

export function canonicalProductRecallConfig(): object {
  return {};
}

export function canonicalProductRecallProvenanceConfig(): object {
  return { conf_slice_compatibility: false };
}
