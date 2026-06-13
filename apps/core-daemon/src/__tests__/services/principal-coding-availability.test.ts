import { describe, expect, it } from "vitest";
import {
  CORE_DAEMON_ENVIRONMENT_TOOLS,
  PRINCIPAL_CODING_REQUIRED_TOOLS,
  derivePrincipalCodingAvailability
} from "../../services/principal-coding-availability.js";

describe("principal coding availability", () => {
  it("reports unavailable when the principal runtime is not configured", () => {
    expect(
      derivePrincipalCodingAvailability({
        runtimeConfigured: false,
        tools: {
          claude: true,
          bwrap: true,
          socat: true
        }
      })
    ).toEqual({
      available: false,
      missingTools: [],
      reason: "Claude Code principal runtime is not configured."
    });
  });

  it("reports unavailable when any required sandbox tool is missing", () => {
    expect(
      derivePrincipalCodingAvailability({
        runtimeConfigured: true,
        tools: {
          claude: true,
          bwrap: true,
          socat: false
        }
      })
    ).toEqual({
      available: false,
      missingTools: ["socat"],
      reason: "Missing required Claude Code sandbox tools: socat"
    });
  });

  it("treats unknown tools as missing", () => {
    expect(
      derivePrincipalCodingAvailability({
        runtimeConfigured: true,
        tools: {
          claude: true
        }
      })
    ).toEqual({
      available: false,
      missingTools: ["bwrap", "socat"],
      reason: "Missing required Claude Code sandbox tools: bwrap, socat"
    });
  });

  it("reports available when runtime and required tools are present", () => {
    expect(
      derivePrincipalCodingAvailability({
        runtimeConfigured: true,
        tools: {
          claude: true,
          bwrap: true,
          socat: true
        }
      })
    ).toEqual({
      available: true,
      missingTools: [],
      reason: null
    });
  });

  it("includes Claude Code prerequisites in the daemon environment probe list", () => {
    expect(PRINCIPAL_CODING_REQUIRED_TOOLS).toEqual(["claude", "bwrap", "socat"]);
    expect(CORE_DAEMON_ENVIRONMENT_TOOLS).toEqual([
      "git",
      "node",
      "pnpm",
      "rg",
      "claude",
      "bwrap",
      "socat"
    ]);
  });
});
