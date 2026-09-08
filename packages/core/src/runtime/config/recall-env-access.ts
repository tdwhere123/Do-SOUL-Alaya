import { parseEnvOptionalNumber } from "./env-value.js";
import { getCoreConfig } from "./install-core-config.js";

type RecallConfig = ReturnType<typeof getCoreConfig>["recall"];
type RecallEnvLookup = Readonly<
  | { readonly matched: false }
  | { readonly matched: true; readonly value: string | undefined }
>;

const RECALL_ENV_NOT_MATCHED: RecallEnvLookup = Object.freeze({ matched: false });

export function recallEnvRaw(name: string): string | undefined {
  const lookup = readRecallDeliveryEnv(getCoreConfig().recall, name);
  return lookup.matched ? lookup.value : undefined;
}

function readRecallDeliveryEnv(recall: RecallConfig, name: string): RecallEnvLookup {
  switch (name) {
    case "ALAYA_RECALL_PROJECTIONS":
      return matched(recall.projectionsEnabled ? "on" : "off");
    case "ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS":
      return matched(recall.extraSynonymClusters);
    default:
      return RECALL_ENV_NOT_MATCHED;
  }
}

function matched(value: string | undefined): RecallEnvLookup {
  return Object.freeze({ matched: true, value });
}

export function recallProjectionScoringEnabled(): boolean {
  return getCoreConfig().recall.projectionsEnabled;
}

export function readRecallPositiveInt(name: string, fallback: number): number {
  const parsed = readInstalledRecallNumber(name);
  if (parsed === undefined) return fallback;
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(parsed);
}

export function readRecallRatio(name: string, fallback: number): number {
  const parsed = readInstalledRecallNumber(name);
  if (parsed === undefined) return fallback;
  if (parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

export function readRecallUnitFloat(name: string, fallback: number): number {
  const parsed = readInstalledRecallNumber(name);
  if (parsed === undefined) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export function readRecallFloat(name: string, fallback: number, min: number): number {
  const parsed = readInstalledRecallNumber(name);
  if (parsed === undefined) return fallback;
  return Math.max(min, parsed);
}

function readInstalledRecallNumber(name: string): number | undefined {
  return parseEnvOptionalNumber(recallEnvRaw(name), name);
}
