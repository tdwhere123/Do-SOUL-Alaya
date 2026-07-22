export interface AuthorizeExtractionArgs {
  readonly action: "probe" | "fill";
  readonly outputPath: string;
  readonly outputTokenCap: number;
  readonly outputTokenField: "max_tokens" | "max_completion_tokens";
  readonly inputPriceUsdPerMillion: number;
  readonly outputPriceUsdPerMillion: number;
  readonly maximumInputTokens: number;
  readonly diskFloorBytes: number;
  readonly probeKey?: string;
  readonly directDeepSeek500Operator?: string;
  readonly directNewApiDeepSeek500Operator?: string;
  readonly targetSelectionPath?: string;
  readonly predecessorAuthorityPath?: string;
  readonly repairInvalidShards: boolean;
}

export function parseAuthorizeExtractionArgs(
  args: ReadonlyArray<string>
): AuthorizeExtractionArgs {
  assertFlagAtMostOnce(args, "--extraction-predecessor-authority");
  const parsed = readAuthorizeExtractionArgs(args);
  assertAuthorizeExtractionArgs(parsed);
  return parsed;
}

function assertFlagAtMostOnce(args: ReadonlyArray<string>, flag: string): void {
  const count = args.filter((token) => token === flag || token.startsWith(`${flag}=`)).length;
  if (count > 1) throw new Error(`${flag} may be provided only once`);
}

function readAuthorizeExtractionArgs(args: ReadonlyArray<string>): AuthorizeExtractionArgs {
  const action = requiredEnum(args, "--extraction-action", ["probe", "fill"] as const);
  const outputTokenField = requiredEnum(
    args, "--extraction-output-token-field", ["max_tokens", "max_completion_tokens"] as const
  );
  return {
    action,
    outputPath: requiredString(args, "--extraction-receipt-out"),
    outputTokenCap: requiredPositiveInt(args, "--extraction-output-token-cap"),
    outputTokenField,
    inputPriceUsdPerMillion: requiredNonNegativeNumber(
      args, "--extraction-input-price-usd-per-million"
    ),
    outputPriceUsdPerMillion: requiredNonNegativeNumber(
      args, "--extraction-output-price-usd-per-million"
    ),
    maximumInputTokens: requiredNonNegativeInt(args, "--extraction-max-input-tokens"),
    diskFloorBytes: requiredNonNegativeInt(args, "--extraction-disk-floor-bytes"),
    probeKey: optionalString(args, "--extraction-probe-key"),
    directDeepSeek500Operator: optionalRequiredString(args, "--direct-deepseek-500-operator"),
    directNewApiDeepSeek500Operator: optionalRequiredString(
      args, "--direct-newapi-deepseek-500-operator"
    ),
    targetSelectionPath: optionalRequiredString(args, "--extraction-target-selection"),
    predecessorAuthorityPath: optionalRequiredString(
      args, "--extraction-predecessor-authority"
    ),
    repairInvalidShards: args.includes("--repair-invalid-shards")
  };
}

function assertAuthorizeExtractionArgs(parsed: AuthorizeExtractionArgs): void {
  if (parsed.action === "probe" && parsed.probeKey === undefined) {
    throw new Error("--extraction-probe-key is required when --extraction-action=probe");
  }
  if (parsed.action === "fill" && parsed.probeKey !== undefined) {
    throw new Error("--extraction-probe-key is only valid when --extraction-action=probe");
  }
  const directOperator = parsed.directDeepSeek500Operator ?? parsed.directNewApiDeepSeek500Operator;
  if (parsed.directDeepSeek500Operator !== undefined &&
      parsed.directNewApiDeepSeek500Operator !== undefined) {
    throw new Error("only one direct DeepSeek 500 operator flag may be provided");
  }
  if (directOperator !== undefined && parsed.action !== "fill") {
    throw new Error("direct DeepSeek 500 operator flags are only valid when --extraction-action=fill");
  }
  if (directOperator !== undefined && (parsed.targetSelectionPath !== undefined ||
      parsed.predecessorAuthorityPath !== undefined)) {
    throw new Error("direct DeepSeek 500 cannot mix target selection or continuation evidence");
  }
  if (parsed.predecessorAuthorityPath !== undefined &&
      (parsed.action !== "fill" || parsed.targetSelectionPath === undefined)) {
    throw new Error("same-root continuation requires a fill target selection");
  }
  if (parsed.repairInvalidShards && (parsed.action !== "fill" || directOperator !== undefined ||
      parsed.targetSelectionPath !== undefined || parsed.predecessorAuthorityPath !== undefined)) {
    throw new Error("--repair-invalid-shards is a standalone fill authority mode");
  }
}

function requiredString(args: ReadonlyArray<string>, flag: string): string {
  const value = optionalString(args, flag);
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function optionalString(args: ReadonlyArray<string>, flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === flag) return args[index + 1];
    if (token?.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

function optionalRequiredString(args: ReadonlyArray<string>, flag: string): string | undefined {
  return args.some((token) => token === flag || token.startsWith(`${flag}=`))
    ? requiredString(args, flag)
    : undefined;
}

function requiredPositiveInt(args: ReadonlyArray<string>, flag: string): number {
  return requiredInteger(args, flag, (value) => value > 0, "a positive integer");
}

function requiredNonNegativeInt(args: ReadonlyArray<string>, flag: string): number {
  return requiredInteger(args, flag, (value) => value >= 0, "a non-negative integer");
}

function requiredInteger(
  args: ReadonlyArray<string>,
  flag: string,
  predicate: (value: number) => boolean,
  description: string
): number {
  const raw = requiredString(args, flag);
  if (!/^\d+$/u.test(raw)) throw new Error(`${flag} must be ${description}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !predicate(value)) {
    throw new Error(`${flag} must be ${description}`);
  }
  return value;
}

function requiredNonNegativeNumber(args: ReadonlyArray<string>, flag: string): number {
  const value = Number(requiredString(args, flag));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative finite number`);
  }
  return value;
}

function requiredEnum<T extends string>(
  args: ReadonlyArray<string>, flag: string, allowed: readonly T[]
): T {
  const value = requiredString(args, flag);
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
