import type { ExtractionRequestProfile } from "../extraction/request-profile.js";

export interface ProviderBinding {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly requestProfile: ExtractionRequestProfile;
  readonly probeCallCeiling: number;
}

/**
 * Plug-in table for extraction vendors. Add a row to attach a new model;
 * probe, replay, and transport remap all read this table.
 */
export const PROVIDER_BINDINGS: readonly ProviderBinding[] = [
  {
    id: "mimo-v2.5",
    aliases: ["Mimo-V2.5", "mimo-v2-flash"],
    requestProfile: "mimo-v2.5-nonthinking-v1",
    probeCallCeiling: 3
  }
];

export const OBSOLETE_REQUEST_PROFILES = [
  "deepseek-v4-nonthinking-v1"
] as const;

export type ObsoleteRequestProfile = (typeof OBSOLETE_REQUEST_PROFILES)[number];

export function resolveVendorModel(model: string): string {
  const normalized = model.trim();
  for (const binding of PROVIDER_BINDINGS) {
    if (binding.id === normalized || binding.aliases.includes(normalized)) {
      return binding.id;
    }
  }
  return normalized;
}

export function findProviderBinding(model: string): ProviderBinding | undefined {
  const id = resolveVendorModel(model);
  return PROVIDER_BINDINGS.find((binding) => binding.id === id);
}

export function requireProviderBinding(model: string): ProviderBinding {
  const binding = findProviderBinding(model);
  if (binding === undefined) {
    throw new Error(`no provider binding registered for model ${model}`);
  }
  return binding;
}

export function isObsoleteRequestProfile(
  profile: string
): profile is ObsoleteRequestProfile {
  return (OBSOLETE_REQUEST_PROFILES as readonly string[]).includes(profile);
}
