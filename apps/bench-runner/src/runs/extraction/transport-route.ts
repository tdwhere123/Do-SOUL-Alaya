import { createHash } from "node:crypto";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import {
  findProviderBinding,
  resolveVendorModel
} from "../provider/catalog.js";

export interface ExtractionTransportRoute {
  readonly providerUrl: string;
  readonly model: string;
}

export interface ExtractionTransportProvenance {
  readonly provider_url_sha256: string;
  readonly model: string;
}

export function resolveExtractionTransportRoute(
  config: Pick<
    CompileSeedExtractionConfig,
    "model" | "providerUrl" | "transportModel" | "transportProviderUrl"
  >
): ExtractionTransportRoute {
  return Object.freeze({
    providerUrl: config.transportProviderUrl ?? config.providerUrl,
    model: resolveVendorModel(config.transportModel ?? config.model)
  });
}

export function assertRequiredRequestProfile(
  config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile" | "transportModel">
): void {
  const vendor = resolveVendorModel(config.transportModel ?? config.model);
  const binding = findProviderBinding(vendor);
  if (binding !== undefined && config.requestProfile !== binding.requestProfile) {
    throw new Error(
      `model ${binding.id} requires request profile ${binding.requestProfile}`
    );
  }
}

export function buildExtractionTransportProvenance(
  config: Parameters<typeof resolveExtractionTransportRoute>[0]
): ExtractionTransportProvenance {
  const route = resolveExtractionTransportRoute(config);
  return Object.freeze({
    provider_url_sha256: `sha256:${createHash("sha256")
      .update(route.providerUrl, "utf8").digest("hex")}`,
    model: route.model
  });
}

export function isExtractionTransportProvenance(
  value: unknown
): value is ExtractionTransportProvenance {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ExtractionTransportProvenance>;
  return typeof candidate.provider_url_sha256 === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.provider_url_sha256) &&
    typeof candidate.model === "string" && candidate.model.length > 0;
}
