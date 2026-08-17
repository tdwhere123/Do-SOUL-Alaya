export const MIMO_REQUEST_PROFILE = "mimo-v2.5-nonthinking-v1" as const;
export const MIMO_MODEL_ID = "mimo-v2.5";
export const MIMO_PROBE_CALL_CEILING = 3;

export function resolveMimoVendorModel(model: string): string {
  const normalized = model.trim();
  if (normalized === "Mimo-V2.5" || normalized === "mimo-v2-flash") return MIMO_MODEL_ID;
  return normalized;
}

export const OBSOLETE_DEEPSEEK_REQUEST_PROFILE = "deepseek-v4-nonthinking-v1" as const;
