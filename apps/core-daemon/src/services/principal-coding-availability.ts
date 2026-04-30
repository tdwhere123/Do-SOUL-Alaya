export const PRINCIPAL_CODING_REQUIRED_TOOLS = ["claude", "bwrap", "socat"] as const;

export const CORE_DAEMON_ENVIRONMENT_TOOLS = [
  "git",
  "node",
  "pnpm",
  "rg",
  ...PRINCIPAL_CODING_REQUIRED_TOOLS
] as const;

export interface PrincipalCodingAvailabilityInput {
  readonly runtimeConfigured: boolean;
  readonly tools: Readonly<Record<string, boolean>>;
}

export interface PrincipalCodingAvailability {
  readonly available: boolean;
  readonly missingTools: readonly string[];
  readonly reason: string | null;
}

export function derivePrincipalCodingAvailability(
  input: PrincipalCodingAvailabilityInput
): PrincipalCodingAvailability {
  if (!input.runtimeConfigured) {
    return {
      available: false,
      missingTools: [],
      reason: "Claude Code principal runtime is not configured."
    };
  }

  const missingTools = PRINCIPAL_CODING_REQUIRED_TOOLS.filter((toolName) => input.tools[toolName] !== true);

  if (missingTools.length > 0) {
    return {
      available: false,
      missingTools,
      reason: `Missing required Claude Code sandbox tools: ${missingTools.join(", ")}`
    };
  }

  return {
    available: true,
    missingTools: [],
    reason: null
  };
}
