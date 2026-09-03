import { createHash } from "node:crypto";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  parseOfficialApiSignals
} from "../official-api-signal-parser.js";
import { inspectRawOfficialApiSignalElements } from "./raw-signal-envelope.js";

export const RAW_ARTIFACT_CONTRACT_VERSION = 1;

export interface ImmutableRawInspection {
  readonly raw_json_sha256: string;
  readonly raw_signal_count: number;
  readonly truncated_final_element: boolean;
}

export interface DerivedReplayIdentityInput {
  readonly rawJsonSha256: string;
  readonly parserSemanticsVersion: string;
  readonly projectionVersion: string;
  readonly materializerVersion: string;
  readonly governanceVersion: string;
}

export function digestRawJson(rawJson: string): string {
  assertCanonicalUtf8Json(rawJson);
  return createHash("sha256").update(rawJson, "utf8").digest("hex");
}

export function inspectImmutableRawJson(rawJson: string): ImmutableRawInspection {
  const rawJsonSha256 = digestRawJson(rawJson);
  const envelope = inspectRawOfficialApiSignalElements(rawJson);
  if (envelope.truncated_final_element) {
    throw new TypeError("raw artifact is truncated");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (cause) {
    throw new TypeError("raw artifact is not strict JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !Array.isArray((parsed as { signals?: unknown }).signals)) {
    throw new TypeError("raw artifact signals array missing");
  }
  return Object.freeze({
    raw_json_sha256: rawJsonSha256,
    raw_signal_count: (parsed as { signals: unknown[] }).signals.length,
    truncated_final_element: false
  });
}

export function computeDerivedReplayIdentity(input: DerivedReplayIdentityInput): string {
  if (!/^[a-f0-9]{64}$/u.test(input.rawJsonSha256)) {
    throw new TypeError("derived replay requires a raw sha256");
  }
  return createHash("sha256")
    .update(String(RAW_ARTIFACT_CONTRACT_VERSION), "utf8")
    .update("\u0000", "utf8")
    .update(input.rawJsonSha256, "utf8")
    .update("\u0000", "utf8")
    .update(input.parserSemanticsVersion, "utf8")
    .update("\u0000", "utf8")
    .update(input.projectionVersion, "utf8")
    .update("\u0000", "utf8")
    .update(input.materializerVersion, "utf8")
    .update("\u0000", "utf8")
    .update(input.governanceVersion, "utf8")
    .digest("hex");
}

export function replayOfficialApiSignalsFromRaw(
  rawJson: string,
  expectedRawSha256: string,
  derivedVersions: Omit<DerivedReplayIdentityInput, "rawJsonSha256">
): Readonly<{
  readonly signals: ReturnType<typeof parseOfficialApiSignals>;
  readonly derivedIdentity: string;
}> {
  const inspected = inspectImmutableRawJson(rawJson);
  if (inspected.raw_json_sha256 !== expectedRawSha256) {
    throw new TypeError("raw artifact digest mismatch");
  }
  return Object.freeze({
    signals: parseOfficialApiSignals(rawJson),
    derivedIdentity: computeDerivedReplayIdentity({
      rawJsonSha256: inspected.raw_json_sha256,
      ...derivedVersions
    })
  });
}

export function currentOfficialApiParserSemanticsVersion(): string {
  return OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION;
}

function assertCanonicalUtf8Json(rawJson: string): void {
  const bytes = Buffer.from(rawJson, "utf8");
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (decoded !== rawJson) {
    throw new TypeError("raw artifact UTF-8 bytes are not canonical");
  }
}
