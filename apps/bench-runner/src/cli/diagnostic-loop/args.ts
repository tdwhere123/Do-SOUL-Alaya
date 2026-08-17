import path from "node:path";
import process from "node:process";
import { parseLongMemEvalVariant } from "../../longmemeval/comparison/dataset-identity.js";
import {
  isDiagnosticLoopMode,
  isDiagnosticLoopPhase,
  type DiagnosticLoopMode,
  type DiagnosticLoopPhase
} from "../../bench/diagnostic-loop/phases.js";
import { isSha256Hex } from "../../bench/diagnostic-loop/identity.js";
import { isExtractionRequestProfile } from "../../bench/extraction/request-profile.js";
import type { DiagnosticLoopRequest } from "../../bench/diagnostic-loop/types.js";
import {
  isObsoleteRequestProfile,
  resolveVendorModel
} from "../../bench/provider/catalog.js";
import { assertRequiredRequestProfile } from "../../bench/extraction/transport-route.js";
import type { LongMemEvalVariant } from "../../longmemeval/ingestion/dataset.js";
import {
  matchFlagToken,
  nextIndex,
  parseNonNegativeInt,
  parsePositiveInt,
  readRequiredFlagValue
} from "../options/flag-values.js";

const DEFAULT_HISTORY_ROOT = path.resolve(process.cwd(), "docs/bench-history");

export interface DiagnosticLoopArgs {
  readonly workRoot: string;
  readonly mode: DiagnosticLoopMode;
  readonly fromPhase?: DiagnosticLoopPhase;
  readonly request: DiagnosticLoopRequest;
}

export function parseDiagnosticLoopArgs(
  args: ReadonlyArray<string>
): DiagnosticLoopArgs {
  const parsed = readArgs(args);
  assertRequired(parsed);
  const mode = parsed.mode ?? "run";
  const variant = parseVariant(parsed.variant ?? "s");
  const requestedKeys = parseRequestedKeys(parsed.requestedKeys);
  const worker = parsed.worker === true || mode === "smoke";
  const model = resolveVendorModel(parsed.model!);
  const requestProfile = parsed.requestProfile!;
  if (!isExtractionRequestProfile(requestProfile)) {
    throw new Error(`unsupported request profile '${requestProfile}'`);
  }
  if (isObsoleteRequestProfile(requestProfile)) {
    throw new Error(`diagnostic-loop refuses obsolete request profile ${requestProfile}`);
  }
  assertRequiredRequestProfile({ model, requestProfile });
  return {
    workRoot: path.resolve(parsed.workRoot!),
    mode,
    ...(parsed.fromPhase === undefined ? {} : { fromPhase: parsed.fromPhase }),
    request: {
      datasetRevision: parsed.datasetRevision!,
      requestedKeys,
      providerRoute: parsed.providerRoute!,
      model,
      requestProfile,
      promptDigest: parsed.promptDigest!,
      schemaDigest: parsed.schemaDigest!,
      operatorDigest: parsed.operatorDigest!,
      cacheMode: "cache_only",
      variant,
      worker,
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.offset === undefined ? {} : { offset: parsed.offset }),
      ...(parsed.extractionCacheRoot === undefined
        ? {}
        : { extractionCacheRoot: parsed.extractionCacheRoot }),
      ...(parsed.snapshot === undefined ? {} : { snapshotPath: parsed.snapshot }),
      ...(parsed.snapshotOut === undefined ? {} : { snapshotOutPath: parsed.snapshotOut }),
      ...(parsed.treatmentFactorCache === undefined
        ? {}
        : { treatmentFactorCachePath: parsed.treatmentFactorCache }),
      historyRoot: parsed.historyRoot ?? DEFAULT_HISTORY_ROOT,
      ...(parsed.dataDir === undefined ? {} : { dataDir: parsed.dataDir })
    }
  };
}

interface RawArgs {
  workRoot?: string;
  mode?: DiagnosticLoopMode;
  fromPhase?: DiagnosticLoopPhase;
  variant?: string;
  limit?: number;
  offset?: number;
  worker?: boolean;
  datasetRevision?: string;
  requestedKeys?: string;
  providerRoute?: string;
  model?: string;
  requestProfile?: string;
  promptDigest?: string;
  schemaDigest?: string;
  operatorDigest?: string;
  extractionCacheRoot?: string;
  snapshot?: string;
  snapshotOut?: string;
  treatmentFactorCache?: string;
  historyRoot?: string;
  dataDir?: string;
}

function readArgs(args: ReadonlyArray<string>): RawArgs {
  const parsed: RawArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    index = consumeToken(args, index, token, parsed);
  }
  return parsed;
}

function consumeToken(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  parsed: RawArgs
): number {
  if (assignString(parsed, args, index, token, "--work-root", "workRoot")) {
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--mode")) {
    const value = required(args, index, token, "--mode");
    if (!isDiagnosticLoopMode(value)) throw new Error(`unsupported --mode ${value}`);
    parsed.mode = value;
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--from-phase")) {
    const value = required(args, index, token, "--from-phase");
    if (!isDiagnosticLoopPhase(value)) throw new Error(`unsupported --from-phase ${value}`);
    parsed.fromPhase = value;
    return nextIndex(index, token);
  }
  if (assignString(parsed, args, index, token, "--variant", "variant") ||
      assignPositive(parsed, args, index, token, "--limit", "limit") ||
      assignNonNegative(parsed, args, index, token, "--offset", "offset") ||
      assignSha(parsed, args, index, token, "--dataset-revision", "datasetRevision") ||
      assignString(parsed, args, index, token, "--requested-keys", "requestedKeys") ||
      assignString(parsed, args, index, token, "--provider-route", "providerRoute") ||
      assignString(parsed, args, index, token, "--model", "model") ||
      assignString(parsed, args, index, token, "--request-profile", "requestProfile") ||
      assignSha(parsed, args, index, token, "--prompt-digest", "promptDigest") ||
      assignSha(parsed, args, index, token, "--schema-digest", "schemaDigest") ||
      assignSha(parsed, args, index, token, "--operator-digest", "operatorDigest") ||
      assignString(parsed, args, index, token, "--extraction-cache-root", "extractionCacheRoot") ||
      assignString(parsed, args, index, token, "--snapshot", "snapshot") ||
      assignString(parsed, args, index, token, "--snapshot-out", "snapshotOut") ||
      assignString(parsed, args, index, token, "--query-semantic-factor-cache", "treatmentFactorCache") ||
      assignString(parsed, args, index, token, "--history-root", "historyRoot") ||
      assignString(parsed, args, index, token, "--data-dir", "dataDir")) {
    return nextIndex(index, token);
  }
  if (token === "--worker") {
    parsed.worker = true;
    return index;
  }
  throw new Error(`unknown diagnostic-loop flag '${token}'`);
}

function assignString(
  parsed: RawArgs,
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  field: keyof RawArgs
): boolean {
  if (!matchFlagToken(token, flag)) return false;
  (parsed[field] as string) = required(args, index, token, flag);
  return true;
}

function assignSha(
  parsed: RawArgs,
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  field: keyof RawArgs
): boolean {
  if (!matchFlagToken(token, flag)) return false;
  const value = required(args, index, token, flag);
  if (!isSha256Hex(value)) throw new Error(`${flag} must be a sha256 hex digest`);
  (parsed[field] as string) = value;
  return true;
}

function assignPositive(
  parsed: RawArgs,
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  field: "limit"
): boolean {
  if (!matchFlagToken(token, flag)) return false;
  parsed[field] = parsePositiveInt(required(args, index, token, flag), flag);
  return true;
}

function assignNonNegative(
  parsed: RawArgs,
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  field: "offset"
): boolean {
  if (!matchFlagToken(token, flag)) return false;
  parsed[field] = parseNonNegativeInt(required(args, index, token, flag), flag);
  return true;
}

function required(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string
): string {
  return readRequiredFlagValue(args, index, token, flag, `${flag} requires a value`);
}

function assertRequired(parsed: RawArgs): void {
  const requiredFlags: Array<keyof RawArgs> = [
    "workRoot", "datasetRevision", "requestedKeys", "providerRoute",
    "model", "requestProfile", "promptDigest", "schemaDigest", "operatorDigest"
  ];
  const missing = requiredFlags.filter((field) => parsed[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required diagnostic-loop flags: ${missing.join(", ")}`);
  }
}

function parseRequestedKeys(raw: string | undefined): readonly string[] {
  const keys = (raw ?? "").split(",").map((key) => key.trim()).filter((key) => key.length > 0);
  if (keys.length === 0) throw new Error("--requested-keys requires at least one sha256 key");
  for (const key of keys) {
    if (!isSha256Hex(key)) throw new Error(`requested key is not a sha256 hex digest: ${key}`);
  }
  return keys;
}

function parseVariant(raw: string): LongMemEvalVariant {
  if (raw === "oracle") return "longmemeval_oracle";
  if (raw === "s") return "longmemeval_s";
  if (raw === "m") return "longmemeval_m";
  return parseLongMemEvalVariant(raw);
}
