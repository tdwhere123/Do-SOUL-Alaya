export function matchFlagToken(token: string, flag: string): boolean {
  return token === flag || token.startsWith(`${flag}=`);
}

export function nextIndex(index: number, token: string): number {
  return token.includes("=") ? index : index + 1;
}

export function readFlagValue(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  fallback?: string
): string | undefined {
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  return args[index + 1] ?? fallback;
}

export function readRequiredFlagValue(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  errorMessage: string
): string {
  const raw = readFlagValue(args, index, token, flag);
  if (raw === undefined) throw new Error(errorMessage);
  return raw;
}

export function parsePositiveInt(
  raw: string | undefined,
  flag: string
): number | undefined {
  return parseIntegerFlag(raw, flag, (value) => value > 0, "positive integer");
}

export function parseNonNegativeInt(
  raw: string | undefined,
  flag: string
): number | undefined {
  return parseIntegerFlag(raw, flag, (value) => value >= 0, "non-negative integer");
}

function parseIntegerFlag(
  raw: string | undefined,
  flag: string,
  predicate: (value: number) => boolean,
  expectation: string
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/u.test(raw)) throw new Error(`${flag} must be a ${expectation}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || !predicate(parsed)) {
    throw new Error(`${flag} must be a ${expectation}`);
  }
  return parsed;
}
