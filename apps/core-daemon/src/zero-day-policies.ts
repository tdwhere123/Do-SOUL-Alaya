import { ZeroDayPolicySchema, type ZeroDayPolicy } from "@do-soul/alaya-protocol";

export function parseZeroDayPoliciesJson(raw: string | undefined): readonly ZeroDayPolicy[] {
  const trimmed = raw?.trim();

  if (trimmed === undefined || trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error("ZERO_DAY_POLICIES_JSON must contain valid JSON.", {
      cause: error instanceof Error ? error : undefined
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error("ZERO_DAY_POLICIES_JSON must decode to an array of policies.");
  }

  return parsed.map((entry) => {
    try {
      return ZeroDayPolicySchema.parse(entry);
    } catch (error) {
      throw new Error("ZERO_DAY_POLICIES_JSON contains an invalid policy.", {
        cause: error instanceof Error ? error : undefined
      });
    }
  });
}
